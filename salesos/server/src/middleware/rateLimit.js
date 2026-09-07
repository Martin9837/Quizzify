import config from '../config.js';
import { tooManyRequests } from '../lib/errors.js';

/**
 * Fixed-window rate limiter, keyed per identity+route-group.
 *
 * In-process by design for a single node; the same interface backed by Redis is
 * the only change needed to scale horizontally. Auth endpoints get a much
 * tighter budget because they are the credential-stuffing surface.
 */
const buckets = new Map();

const SWEEP_INTERVAL_MS = 60000;
let lastSweep = 0;

/**
 * Drop expired buckets as requests arrive, rather than on a timer.
 *
 * This used to be a module-scope `setInterval`. A sweep is only ever needed
 * while the map is being used, so doing it here costs nothing extra -- and a
 * timer cannot be created at module scope on every host: Workers rejects it
 * outright with "Disallowed operation called within global scope", before any
 * request is served.
 */
function sweepExpired(now) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}

function hit(key, max, windowMs) {
  const now = Date.now();
  sweepExpired(now);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1, resetAt: now + windowMs };
  }
  bucket.count += 1;
  return { allowed: bucket.count <= max, remaining: Math.max(0, max - bucket.count), resetAt: bucket.resetAt };
}

export function rateLimit({ max = config.rateLimit.max, windowMs = config.rateLimit.windowMs, scope = 'api' } = {}) {
  return (req, res, next) => {
    const identity = req.auth?.userId || req.ip || 'anonymous';
    const result = hit(`${scope}:${identity}`, max, windowMs);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))));
      return next(tooManyRequests());
    }
    return next();
  };
}

export default rateLimit;
