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

function hit(key, max, windowMs) {
  const now = Date.now();
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

// Periodically drop expired buckets so memory does not grow unbounded.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60000);
sweeper.unref?.();

export default rateLimit;
