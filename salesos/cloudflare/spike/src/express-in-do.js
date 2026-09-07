import { DurableObject } from 'cloudflare:workers';
import express from 'express';
import { Readable } from 'node:stream';

/**
 * Can the existing Express app serve requests from inside a Durable Object?
 * If yes, the routers, middleware and services move across untouched and only
 * the db driver changes. If no, the route layer has to be re-fronted.
 */

let bridge = null;
let bridgeError = null;
try {
  // The documented way to run a node:http server on Workers.
  const mod = await import('cloudflare:node');
  bridge = mod.httpServerHandler ? mod : null;
  if (!bridge) bridgeError = `cloudflare:node exports ${Object.keys(mod).join(', ') || '(nothing)'}`;
} catch (error) {
  bridgeError = error.message;
}

export class ExpressObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT)');

    // A small stand-in for the real app: middleware, a router, JSON parsing,
    // an error handler, and a route that reads synchronously from SQL.
    const app = express();
    // Deliberately NOT express.json(): body-parser reaches iconv-lite, which
    // fails to load on workerd ("require_streams(...) is not a function").
    // The bridge below has already read the whole body, so it fills req.body.
    const router = express.Router();
    router.get('/notes', (req, res) => {
      const rows = [...this.sql.exec('SELECT id, body FROM notes ORDER BY id')];
      res.json({ notes: rows, total: rows.length });
    });
    router.post('/notes', (req, res) => {
      const id = `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
      this.sql.exec('INSERT INTO notes VALUES (?, ?)', id, req.body?.body ?? '');
      res.status(201).json({ id });
    });
    router.get('/boom', () => { throw new Error('deliberate route failure'); });
    app.use('/api/v1', router);
    app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
    app.use((req, res) => res.status(404).json({ error: 'not found' }));
    this.app = app;
  }

  /** Feed a Fetch Request through Express without a socket. */
  async serve(request) {
    const url = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? null
      : Buffer.from(await request.arrayBuffer());

    return new Promise((resolve, reject) => {
      const headers = {};
      for (const [key, value] of request.headers) headers[key.toLowerCase()] = value;

      // Minimal IncomingMessage: Express reads method/url/headers and, for
      // express.json(), streams the body.
      let parsedBody;
      if (body && /application\/json/.test(headers['content-type'] || '')) {
        try { parsedBody = JSON.parse(body.toString('utf8')); } catch { parsedBody = undefined; }
      }

      const req = Object.assign(new Readable({
        read() {
          if (body) this.push(body);
          this.push(null);
        },
      }), {
        method: request.method,
        url: url.pathname + url.search,
        headers,
        httpVersion: '1.1',
        socket: { remoteAddress: '127.0.0.1', encrypted: false },
        connection: { remoteAddress: '127.0.0.1' },
        body: parsedBody,
      });

      const chunks = [];
      const resHeaders = {};
      const res = {
        statusCode: 200,
        headersSent: false,
        setHeader(name, value) { resHeaders[name.toLowerCase()] = value; return this; },
        getHeader(name) { return resHeaders[name.toLowerCase()]; },
        getHeaderNames() { return Object.keys(resHeaders); },
        removeHeader(name) { delete resHeaders[name.toLowerCase()]; },
        hasHeader(name) { return name.toLowerCase() in resHeaders; },
        writeHead(code, maybeHeaders) {
          this.statusCode = code;
          Object.assign(resHeaders, maybeHeaders || {});
          this.headersSent = true;
          return this;
        },
        write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
        end(chunk) {
          if (chunk) chunks.push(Buffer.from(chunk));
          resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, {
            status: this.statusCode,
            headers: resHeaders,
          }));
          return this;
        },
        on() { return this; },
        once() { return this; },
        emit() { return false; },
        removeListener() { return this; },
        flushHeaders() { return this; },
        vary() { return this; },
      };

      try {
        this.app(req, res, (error) => reject(error || new Error('fell through Express')));
      } catch (error) {
        reject(error);
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__probe') {
      const checks = [];
      const ok = (name, good, detail = '') => checks.push({ name, ok: Boolean(good), detail: String(detail).slice(0, 160) });
      ok('cloudflare:node exposes httpServerHandler', Boolean(bridge), bridgeError || 'available');

      const call = async (method, path, payload) => {
        const response = await this.serve(new Request(`https://do.local${path}`, {
          method,
          headers: payload ? { 'content-type': 'application/json' } : {},
          body: payload ? JSON.stringify(payload) : undefined,
        }));
        let parsed = null;
        const text = await response.text();
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        return { status: response.status, body: parsed, type: response.headers.get('content-type') };
      };

      try {
        const created = await call('POST', '/api/v1/notes', { body: 'first note from inside a Durable Object' });
        ok('a POST with a JSON body parsed by the bridge works', created.status === 201 && created.body?.id,
          JSON.stringify(created));

        const listed = await call('GET', '/api/v1/notes');
        ok('a GET through an Express Router reads synchronous SQL',
          listed.status === 200 && listed.body?.total >= 1, JSON.stringify(listed.body).slice(0, 120));
        ok('Express sets its own JSON content type', /application\/json/.test(listed.type || ''), listed.type);

        const missing = await call('GET', '/api/v1/nope');
        ok('the 404 fall-through middleware runs', missing.status === 404, JSON.stringify(missing));

        const boom = await call('GET', '/api/v1/boom');
        ok('the error-handling middleware catches a throwing route',
          boom.status === 500 && /deliberate/.test(JSON.stringify(boom.body)), JSON.stringify(boom));
      } catch (error) {
        ok('Express served a request inside the Durable Object', false, `${error.message}`);
      }

      return Response.json({ checks, passed: checks.filter((c) => c.ok).length, total: checks.length });
    }
    return this.serve(request);
  }
}

export default {
  fetch(request, env) {
    return env.EXPRESS.getByName('one').fetch(request);
  },
};
