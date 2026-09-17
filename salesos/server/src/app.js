import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import logger from './lib/logger.js';
import { get } from './db/index.js';
import apiRouter from './routes/index.js';
import { requestContext, securityHeaders } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { connectionCount } from './services/realtime/index.js';
import { stats as queueStats } from './services/queue/index.js';

// `import.meta.url` is undefined on Workers, where computing this at module
// scope threw before any route was registered. It is only needed to find the
// built client on disk, which a host without a filesystem does not serve.
const moduleDir = () => (import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : '');

/**
 * Origins the installed mobile app loads its own bundle from. Capacitor serves
 * the web assets from these fixed schemes, so a native client's requests always
 * arrive cross-origin no matter which server it is pointed at.
 *
 * Allowing them is not a weakening of the boundary: every endpoint here is
 * authenticated by a bearer token, and a native app is not bound by CORS in the
 * first place -- it can issue plain HTTP requests outside the web view. Refusing
 * them would only break the legitimate app while stopping nobody.
 */
const NATIVE_APP_ORIGINS = new Set([
  'capacitor://localhost',
  'ionic://localhost',
]);

/**
 * Seconds since this instance started serving.
 *
 * `process.uptime()` is a stub returning 0 on workerd, which is where this
 * actually runs in production -- so /health reported an uptime of 0 forever,
 * and any monitor watching for restarts saw one on every poll. Stamped on the
 * first call rather than at module scope: a Durable Object evaluates its
 * module long before it is asked to serve anything, and time in global scope
 * on Workers is frozen until the first request.
 */
let firstServedAt = null;
function uptimeSeconds() {
  const node = typeof process?.uptime === 'function' ? Math.round(process.uptime()) : 0;
  if (node > 0) return node;
  if (firstServedAt === null) firstServedAt = Date.now();
  return Math.round((Date.now() - firstServedAt) / 1000);
}

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(requestContext);
  /**
   * CORS.
   *
   * Two things matter here. First, when this process also serves the built
   * client, its own origin must be allowed -- otherwise the app cannot load its
   * own assets. Second, a disallowed origin must simply not receive CORS
   * headers; throwing would turn every such request into a 500 rather than a
   * clean browser-side block.
   */
  app.use(cors((req, callback) => {
    const origin = req.header('Origin');
    const selfOrigin = `${req.protocol}://${req.get('host')}`;
    const allowed = !origin
      || origin === selfOrigin
      || config.webOrigins.includes('*')
      || config.webOrigins.includes(origin)
      || origin === config.publicUrl
      || NATIVE_APP_ORIGINS.has(origin);
    if (origin && !allowed) {
      logger.debug('cors origin rejected', { origin, requestId: req.id });
    }
    callback(null, {
      origin: allowed ? origin || true : false,
      credentials: true,
      exposedHeaders: ['x-request-id', 'X-RateLimit-Remaining'],
    });
  }));
  app.use(express.json({ limit: '12mb' }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));

  app.get('/health', (req, res) => {
    let dbOk = true;
    try {
      // Through the db helpers, so the check works on whichever engine is installed.
      get('SELECT 1 AS ok');
    } catch {
      dbOk = false;
    }
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      version: '1.0.0',
      environment: config.env,
      uptimeSeconds: uptimeSeconds(),
      database: dbOk ? 'ok' : 'unavailable',
      realtimeConnections: connectionCount(),
      queue: { inFlight: queueStats().inFlight, handlers: queueStats().handlers.length },
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api/v1', apiRouter);

  // Serve the built SPA when it exists, so a single process can host both.
  const here = moduleDir();
  const webDist = here ? path.resolve(here, '../../web/dist') : '';
  if (webDist && fs.existsSync(webDist)) {
    // The service worker decides when every other asset is refreshed, so it must
    // not itself be served from a stale cache -- otherwise a deploy can take an
    // hour to reach an installed client. Revalidate it on every request.
    app.get('/sw.js', (req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.type('application/javascript');
      res.sendFile(path.join(webDist, 'sw.js'));
    });
    app.use(express.static(webDist, { maxAge: '1h', index: false }));

    // A request for a *file* that is not there is a 404, not the app shell.
    //
    // The catch-all below is what makes client-side routing work: any path the
    // server does not know is answered with index.html so the SPA can route
    // it. Applied to asset paths too, that turns a missing file into an HTML
    // page served under the name of a script -- and a browser asked to parse
    // index.html as a JavaScript module fails, leaving a white screen with no
    // clue as to why. Every rebuild renames the hashed bundles, so any client
    // holding the previous index.html hits exactly that.
    const ASSET_REQUEST = /^\/assets\/|\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|json|txt|webmanifest)$/i;

    app.get(/^\/(?!api|health).*/, (req, res, next) => {
      if (ASSET_REQUEST.test(req.path)) return next();
      return res.sendFile(path.join(webDist, 'index.html'), (error) => (error ? next(error) : undefined));
    });
    logger.info('serving built web client', { path: webDist });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export default createApp;
