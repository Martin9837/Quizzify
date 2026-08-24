import { Router } from 'express';
import { validate } from '../lib/validate.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import * as notificationService from '../services/notifications/index.js';

const router = Router();

// GET /notifications
router.get('/', asyncHandler(async (req, res) => {
  res.json({
    notifications: notificationService.listForUser(req.auth.userId, {
      unreadOnly: req.query.unreadOnly === 'true',
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
    }),
    unread: notificationService.unreadCount(req.auth.userId),
  });
}));

// POST /notifications/read
router.post('/read', asyncHandler(async (req, res) => {
  const body = validate(req.body || {}, {
    ids: { type: 'array', of: 'string', maxItems: 200 },
    all: { type: 'boolean', default: false },
  }, { partial: true });
  const changed = body.all
    ? notificationService.markAllRead(req.auth.userId)
    : notificationService.markRead(req.auth.userId, body.ids || []);
  res.json({ updated: changed, unread: notificationService.unreadCount(req.auth.userId) });
}));

export default router;
