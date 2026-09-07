import { Readable } from 'node:stream';

/**
 * Run an Express app from inside a Durable Object.
 *
 * A Durable Object has no listening socket, so there is no `node:http` server
 * for Express to sit behind. This turns a Fetch `Request` into the subset of
 * `IncomingMessage`/`ServerResponse` that Express and its middleware actually
 * touch, and resolves a `Response` when the handler ends.
 *
 * The body is read up front and handed over as `req.body` with `req._body`
 * set, which is the flag body-parser checks before doing anything -- so
 * `express.json()` stays in `app.js` and simply no-ops here. That keeps the
 * Node path byte-identical rather than swapping in a second parser that would
 * have to be trusted separately.
 */

/** Streamed responses cannot wait for `end()`; these are handed back early. */
const STREAMING = /^text\/event-stream/i;

export function createExpressBridge(app, { maxBodyBytes = 12 * 1024 * 1024 } = {}) {
  return async function serve(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    let body = null;
    if (method !== 'GET' && method !== 'HEAD') {
      body = Buffer.from(await request.arrayBuffer());
      if (body.length > maxBodyBytes) {
        // The limit express.json() would have enforced, enforced here instead,
        // since the parser it belongs to never runs on this path.
        return Response.json({ error: 'Request body too large' }, { status: 413 });
      }
    }

    const headers = {};
    for (const [name, value] of request.headers) headers[name.toLowerCase()] = value;

    const contentType = headers['content-type'] || '';
    let parsed;
    let preParsed = false;
    if (body && body.length && /^application\/json/i.test(contentType)) {
      try {
        parsed = JSON.parse(body.toString('utf8'));
        preParsed = true;
      } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
    } else if (body && body.length && /^application\/x-www-form-urlencoded/i.test(contentType)) {
      parsed = Object.fromEntries(new URLSearchParams(body.toString('utf8')));
      preParsed = true;
    }

    const req = new Readable({
      read() {
        if (body && body.length) this.push(body);
        this.push(null);
      },
    });
    Object.assign(req, {
      method,
      url: url.pathname + url.search,
      originalUrl: url.pathname + url.search,
      headers,
      rawHeaders: Object.entries(headers).flat(),
      httpVersion: '1.1',
      httpVersionMajor: 1,
      httpVersionMinor: 1,
      complete: true,
      // `x-forwarded-for` is what Cloudflare puts the client address in; the
      // rate limiter and the audit trail both read `req.ip` off this.
      socket: {
        remoteAddress: headers['cf-connecting-ip'] || headers['x-forwarded-for'] || '127.0.0.1',
        encrypted: url.protocol === 'https:',
      },
      body: preParsed ? parsed : undefined,
      // body-parser's own short-circuit, so express.json() leaves this alone.
      _body: preParsed,
    });
    req.connection = req.socket;

    return new Promise((resolve, reject) => {
      const chunks = [];
      const outHeaders = {};
      let stream = null;
      let settled = false;

      const finish = (status) => {
        if (settled) return;
        settled = true;
        resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, {
          status,
          headers: outHeaders,
        }));
      };

      /** Once the headers say event-stream, the response body has to flow. */
      const beginStreaming = () => {
        if (stream || settled) return;
        const { readable, writable } = new TransformStream();
        stream = writable.getWriter();
        settled = true;
        for (const chunk of chunks) stream.write(chunk);
        chunks.length = 0;
        resolve(new Response(readable, { status: res.statusCode, headers: outHeaders }));
      };

      const res = {
        statusCode: 200,
        headersSent: false,

        setHeader(name, value) { outHeaders[name.toLowerCase()] = value; return this; },
        getHeader(name) { return outHeaders[name.toLowerCase()]; },
        getHeaders() { return { ...outHeaders }; },
        getHeaderNames() { return Object.keys(outHeaders); },
        hasHeader(name) { return name.toLowerCase() in outHeaders; },
        removeHeader(name) { delete outHeaders[name.toLowerCase()]; return this; },

        writeHead(status, maybeReason, maybeHeaders) {
          this.statusCode = status;
          const extra = typeof maybeReason === 'object' ? maybeReason : maybeHeaders;
          for (const [name, value] of Object.entries(extra || {})) {
            outHeaders[name.toLowerCase()] = value;
          }
          this.headersSent = true;
          if (STREAMING.test(String(outHeaders['content-type'] || ''))) beginStreaming();
          return this;
        },

        flushHeaders() {
          this.headersSent = true;
          if (STREAMING.test(String(outHeaders['content-type'] || ''))) beginStreaming();
          return this;
        },

        write(chunk, _encoding, callback) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          if (!stream && STREAMING.test(String(outHeaders['content-type'] || ''))) beginStreaming();
          if (stream) stream.write(buffer).catch(() => {});
          else chunks.push(buffer);
          callback?.();
          return true;
        },

        end(chunk, _encoding, callback) {
          if (chunk) this.write(chunk);
          if (stream) stream.close().catch(() => {});
          else finish(this.statusCode);
          callback?.();
          return this;
        },

        // Express and the SSE code treat the response as an EventEmitter. Only
        // 'close' matters, and a Durable Object gives no disconnect signal, so
        // the listeners are held rather than dropped on the floor.
        listeners: new Map(),
        on(event, listener) {
          const existing = this.listeners.get(event) || [];
          this.listeners.set(event, [...existing, listener]);
          return this;
        },
        once(event, listener) { return this.on(event, listener); },
        removeListener(event, listener) {
          this.listeners.set(event, (this.listeners.get(event) || []).filter((l) => l !== listener));
          return this;
        },
        off(event, listener) { return this.removeListener(event, listener); },
        emit(event, ...args) {
          const listeners = this.listeners.get(event) || [];
          listeners.forEach((listener) => listener(...args));
          return listeners.length > 0;
        },
      };
      res.req = req;
      req.res = res;

      try {
        app(req, res, (error) => {
          if (error) reject(error);
          else finish(404);
        });
      } catch (error) {
        reject(error);
      }
    });
  };
}

export default createExpressBridge;
