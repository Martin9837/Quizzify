import { Router } from 'express';
import { all, get, parseJson, inList } from '../db/index.js';
import { parsePagination } from '../lib/validate.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ownerScopeClause } from '../middleware/auth.js';
import { ACTIVITY_TYPES } from '../lib/constants.js';

const router = Router();

/**
 * Communication hub: one feed of everything that happened, across channels.
 * Scoped by the lead owner so an agent's feed stays their own.
 */
router.get('/', asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 60, maxLimit: 200 });
  const scope = ownerScopeClause(req, 'l.owner_id', { includeUnassigned: true });
  const params = [req.auth.organizationId, ...scope.params];
  const filters = [];
  if (req.query.types) {
    const types = String(req.query.types).split(',').filter((t) => ACTIVITY_TYPES.includes(t));
    if (types.length) {
      const kinds = inList('a.type', types);
      filters.push(kinds.sql);
      params.push(...kinds.params);
    }
  }
  if (req.query.leadId) {
    filters.push('a.lead_id = ?');
    params.push(req.query.leadId);
  }
  if (req.query.actorType) {
    filters.push('a.actor_type = ?');
    params.push(req.query.actorType);
  }
  if (req.query.since) {
    filters.push('a.occurred_at >= ?');
    params.push(req.query.since);
  }

  const where = `WHERE a.organization_id = ?${scope.sql}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`;
  const rows = all(
    `SELECT a.*, l.first_name, l.last_name, l.company_name, u.name AS actor_name
     FROM activities a
     LEFT JOIN leads l ON l.id = a.lead_id
     LEFT JOIN users u ON u.id = a.actor_id
     ${where} ORDER BY a.occurred_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  res.json({
    activities: rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      leadId: row.lead_id,
      dealId: row.deal_id,
      refId: row.ref_id,
      actorId: row.actor_id,
      actorType: row.actor_type,
      actorName: row.actor_type === 'ai' ? 'AI' : row.actor_name,
      contactName: row.first_name ? `${row.first_name} ${row.last_name || ''}`.trim() : null,
      companyName: row.company_name,
      metadata: parseJson(row.metadata, {}),
      occurredAt: row.occurred_at,
    })),
    limit,
    offset,
    types: ACTIVITY_TYPES,
  });
}));

export default router;
