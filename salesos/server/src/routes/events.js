import { Router } from 'express';
import { subscribe } from '../services/realtime/index.js';

const router = Router();

/**
 * Server-Sent Events stream.
 *
 * Browsers cannot set headers on an EventSource, so this route accepts the
 * access token as a query parameter -- `authenticate` supports both.
 */
router.get('/', (req, res) => {
  subscribe(req, res, {
    id: req.auth.userId,
    organizationId: req.auth.organizationId,
    role: req.auth.role,
  });
});

export default router;
