import { requestId } from '../lib/ids.js';
import logger from '../lib/logger.js';

/** Attaches a request id and logs completion with timing and status. */
export function requestContext(req, res, next) {
  req.id = req.get('x-request-id') || requestId();
  res.setHeader('x-request-id', req.id);
  req.startedAt = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - req.startedAt;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    logger[level](`${req.method} ${req.originalUrl} ${res.statusCode}`, {
      requestId: req.id,
      durationMs,
      userId: req.auth?.userId,
      organizationId: req.auth?.organizationId,
    });
  });
  next();
}

/** Baseline security headers. A CDN or reverse proxy would normally add these. */
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(self)');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
}

export default { requestContext, securityHeaders };
