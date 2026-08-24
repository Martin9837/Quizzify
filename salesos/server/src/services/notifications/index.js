import { insert, all, get, run, parseJson } from '../../db/index.js';
import { id } from '../../lib/ids.js';
import { nowIso } from '../../lib/time.js';
import { emitToUser, emitToManagers } from '../realtime/index.js';
import { enqueue } from '../queue/index.js';
import logger from '../../lib/logger.js';

/**
 * Notification fan-out. In-app delivery is immediate (SSE); e-mail delivery is
 * queued so a slow SMTP endpoint can never block a request.
 */
export function notify({
  organizationId,
  userId,
  type,
  title,
  body = null,
  priority = 'normal',
  entityType = null,
  entityId = null,
  link = null,
  channels = ['in_app'],
}) {
  const row = {
    id: id('ntf'),
    organization_id: organizationId,
    user_id: userId,
    type,
    title,
    body,
    priority,
    entity_type: entityType,
    entity_id: entityId,
    link,
    channels: JSON.stringify(channels),
    created_at: nowIso(),
  };
  insert('notifications', row);

  emitToUser(userId, 'notification.created', {
    id: row.id, type, title, body, priority, link, entityType, entityId, createdAt: row.created_at,
  });

  if (channels.includes('email')) {
    enqueue('notification.email', { notificationId: row.id }, { organizationId, priority: 6 });
  }
  logger.debug('notification created', { type, userId, priority });
  return row;
}

/** Alert every manager/admin in the org (used for at-risk deals, SLA breaches). */
export function notifyManagers({ organizationId, type, title, body, link, entityType, entityId, priority = 'high' }) {
  const managers = all(
    `SELECT id FROM users WHERE organization_id = ? AND role IN ('manager','admin','super_admin') AND status = 'active'`,
    [organizationId],
  );
  for (const manager of managers) {
    notify({ organizationId, userId: manager.id, type, title, body, link, entityType, entityId, priority });
  }
  emitToManagers(organizationId, 'manager.alert', { type, title, body, link });
  return managers.length;
}

export function listForUser(userId, { unreadOnly = false, limit = 50, offset = 0 } = {}) {
  let sql = 'SELECT * FROM notifications WHERE user_id = ?';
  const params = [userId];
  if (unreadOnly) sql += ' AND read_at IS NULL';
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return all(sql, params).map((n) => ({ ...n, channels: parseJson(n.channels, ['in_app']) }));
}

export function unreadCount(userId) {
  return get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [userId])?.n || 0;
}

export function markRead(userId, notificationIds) {
  if (!notificationIds?.length) return 0;
  const placeholders = notificationIds.map(() => '?').join(', ');
  const result = run(
    `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${placeholders})`,
    [nowIso(), userId, ...notificationIds],
  );
  emitToUser(userId, 'notification.read', { ids: notificationIds, unread: unreadCount(userId) });
  return result.changes;
}

export function markAllRead(userId) {
  const result = run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [nowIso(), userId]);
  emitToUser(userId, 'notification.read', { all: true, unread: 0 });
  return result.changes;
}

export default { notify, notifyManagers, listForUser, unreadCount, markRead, markAllRead };
