import { AppError } from '../lib/errors.js';
import logger from '../lib/logger.js';
import config from '../config.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` },
    requestId: req.id,
  });
}

/**
 * Terminal error handler. Client errors return their message; anything else
 * returns a generic message and logs the detail, so internals never leak.
 */
export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  if (error instanceof AppError) {
    if (error.status >= 500) {
      logger.error('request failed', { requestId: req.id, code: error.code, message: error.message, details: error.details });
    }
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
      requestId: req.id,
    });
  }

  // Body parser errors arrive as plain SyntaxError with a status.
  if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    return res.status(400).json({
      error: { code: 'bad_request', message: 'Request body is not valid JSON' },
      requestId: req.id,
    });
  }
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      error: { code: 'payload_too_large', message: 'Request body is too large' },
      requestId: req.id,
    });
  }

  logger.error('unhandled error', { requestId: req.id, message: error?.message, stack: error?.stack });
  return res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Something went wrong on our side. The incident has been logged.',
      ...(config.isProd ? {} : { debug: error?.message }),
    },
    requestId: req.id,
  });
}

/** Wraps async handlers so a rejected promise reaches the error handler. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export default { errorHandler, notFoundHandler, asyncHandler };
