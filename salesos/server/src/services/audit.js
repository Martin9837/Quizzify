import { insert, all, get } from '../db/index.js';
import { id } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import logger from '../lib/logger.js';

/**
 * Append-only audit trail.
 *
 * Every mutation that matters -- CRM edits, AI-applied changes, permission
 * changes, recording deletions -- lands here with before/after snapshots so an
 * organisation can answer "who changed this, when, and why" without guessing.
 */

const REDACTED_FIELDS = new Set(['password', 'password_hash', 'refresh_token_hash', 'credentials_enc', 'secret', 'key_hash']);

function sanitise(value) {
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = REDACTED_FIELDS.has(k) ? '[redacted]' : v;
  return out;
}

/** Field-level diff so the audit UI can render "X: old -> new" rows. */
export function diffOf(before, after) {
  if (!before || !after) return null;
  const changes = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (REDACTED_FIELDS.has(key)) continue;
    const a = before[key];
    const b = after[key];
    const same = typeof a === 'object' || typeof b === 'object'
      ? JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
      : a === b;
    if (!same) changes[key] = { from: a ?? null, to: b ?? null };
  }
  return Object.keys(changes).length ? changes : null;
}

export function record({
  organizationId,
  actorId = null,
  actorType = 'user',
  actorLabel = null,
  action,
  entityType = null,
  entityId = null,
  before = null,
  after = null,
  source = 'api',
  ip = null,
  userAgent = null,
  requestId = null,
}) {
  const entry = {
    id: id('aud'),
    organization_id: organizationId,
    actor_id: actorId,
    actor_type: actorType,
    actor_label: actorLabel,
    action,
    entity_type: entityType,
    entity_id: entityId,
    before: before ? JSON.stringify(sanitise(before)) : null,
    after: after ? JSON.stringify(sanitise(after)) : null,
    diff: (() => {
      const d = diffOf(before, after);
      return d ? JSON.stringify(d) : null;
    })(),
    source,
    ip,
    user_agent: userAgent,
    request_id: requestId,
    created_at: nowIso(),
  };
  insert('audit_logs', entry);
  logger.debug('audit', { action, entityType, entityId, actorType });
  return entry.id;
}

/** Convenience wrapper that pulls actor/ip/request-id from an Express request. */
export function recordFromRequest(req, payload) {
  return record({
    organizationId: payload.organizationId || req.auth?.organizationId,
    actorId: payload.actorId ?? req.auth?.userId ?? null,
    actorType: payload.actorType || (req.auth ? 'user' : 'system'),
    actorLabel: payload.actorLabel || req.auth?.email || null,
    source: payload.source || 'ui',
    ip: req.ip,
    userAgent: req.get?.('user-agent') || null,
    requestId: req.id,
    ...payload,
  });
}

export function list({ organizationId, entityType, entityId, actorId, action, actorType, limit = 100, offset = 0, since }) {
  const params = [organizationId];
  let sql = 'SELECT * FROM audit_logs WHERE organization_id = ?';
  if (entityType) {
    sql += ' AND entity_type = ?';
    params.push(entityType);
  }
  if (entityId) {
    sql += ' AND entity_id = ?';
    params.push(entityId);
  }
  if (actorId) {
    sql += ' AND actor_id = ?';
    params.push(actorId);
  }
  if (actorType) {
    sql += ' AND actor_type = ?';
    params.push(actorType);
  }
  if (action) {
    sql += ' AND action LIKE ?';
    params.push(`${action}%`);
  }
  if (since) {
    sql += ' AND created_at >= ?';
    params.push(since);
  }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return all(sql, params);
}

export function count({ organizationId, since }) {
  const row = since
    ? get('SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id = ? AND created_at >= ?', [organizationId, since])
    : get('SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id = ?', [organizationId]);
  return row?.n || 0;
}

export default { record, recordFromRequest, list, count, diffOf };
