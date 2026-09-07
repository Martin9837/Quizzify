import { insert, all, inList } from '../db/index.js';
import { id } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { emitToOrg } from './realtime/index.js';

/**
 * Unified activity timeline. Calls, emails, messages, meetings, notes, tasks,
 * CRM changes and AI insights all land in one table so a lead's history reads
 * as a single conversation rather than eight disconnected tabs.
 */
export function log({
  organizationId,
  leadId = null,
  dealId = null,
  companyId = null,
  actorId = null,
  actorType = 'user',
  type,
  refId = null,
  title,
  body = null,
  metadata = {},
  occurredAt = null,
  broadcast = true,
}) {
  const entry = {
    id: id('act'),
    organization_id: organizationId,
    lead_id: leadId,
    deal_id: dealId,
    company_id: companyId,
    actor_id: actorId,
    actor_type: actorType,
    type,
    ref_id: refId,
    title,
    body,
    metadata: JSON.stringify(metadata || {}),
    occurred_at: occurredAt || nowIso(),
    created_at: nowIso(),
  };
  insert('activities', entry);
  if (broadcast) {
    emitToOrg(organizationId, 'activity.created', {
      id: entry.id, leadId, dealId, type, title, occurredAt: entry.occurred_at, actorType,
    });
  }
  return entry;
}

export function timeline({ organizationId, leadId, dealId, types, limit = 100, offset = 0, since }) {
  const params = [organizationId];
  let sql = 'SELECT * FROM activities WHERE organization_id = ?';
  if (leadId) {
    sql += ' AND lead_id = ?';
    params.push(leadId);
  }
  if (dealId) {
    sql += ' AND deal_id = ?';
    params.push(dealId);
  }
  if (types?.length) {
    const kinds = inList('type', types);
    sql += ` AND ${kinds.sql}`;
    params.push(...kinds.params);
  }
  if (since) {
    sql += ' AND occurred_at >= ?';
    params.push(since);
  }
  sql += ' ORDER BY occurred_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return all(sql, params);
}

export default { log, timeline };
