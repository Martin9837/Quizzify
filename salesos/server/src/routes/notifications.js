import { Router } from 'express';
import { validate, boundedInt } from '../lib/validate.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import * as notificationService from '../services/notifications/index.js';

const router = Router();

// GET /notifications
router.get('/', asyncHandler(async (req, res) => {
  // limit and offset were accepted and then not echoed, so a client could not
  // tell what page it was looking at or whether another one existed.
  const limit = boundedInt(req.query.limit, 50, { max: 200 });
  const offset = boundedInt(req.query.offset, 0, { min: 0, max: 100000 });
  const unreadOnly = req.query.unreadOnly === 'true';
  res.json({
    notifications: notificationService.listForUser(req.auth.userId, { unreadOnly, limit, offset }),
    total: notificationService.countForUser(req.auth.userId, { unreadOnly }),
    limit,
    offset,
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
