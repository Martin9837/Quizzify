import { Router } from 'express';
import { all, get, run, parseJson } from '../db/index.js';
import { validate, parsePagination, finiteNumber } from '../lib/validate.js';
import { PIPELINE_STAGES, STAGE_KEYS, STAGE_MAP } from '../lib/constants.js';
import { notFound, lostReasonRequired } from '../lib/errors.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requirePermission, ownerScopeClause, assertRecordAccess, visibleUserIds } from '../middleware/auth.js';
import * as crm from '../services/crm.js';
import * as insights from '../services/ai/insights.js';
import * as activityService from '../services/activity.js';
import { nowIso } from '../lib/time.js';

const router = Router();

const DEAL_SCHEMA = {
  leadId: { type: 'string', maxLength: 40 },
  name: { type: 'string', maxLength: 160 },
  stage: { type: 'string', enum: STAGE_KEYS },
  value: { type: 'number', min: 0 },
  currency: { type: 'string', maxLength: 4 },
  probability: { type: 'number', min: 0, max: 100, integer: true },
  expectedCloseDate: { type: 'date' },
  ownerId: { type: 'string', maxLength: 40 },
  product: { type: 'string', maxLength: 120 },
  competitors: { type: 'array', of: 'string', maxItems: 15 },
  painPoints: { type: 'array', of: 'string', maxItems: 15 },
  requirements: { type: 'array', of: 'string', maxItems: 20 },
  decisionMaker: { type: 'string', maxLength: 160 },
  budget: { type: 'number', min: 0 },
  timeline: { type: 'string', maxLength: 120 },
  lostReason: { type: 'string', maxLength: 300 },
  position: { type: 'number', integer: true },
  customFields: { type: 'object' },
};

// GET /deals/pipeline  -- board view, grouped by stage
router.get('/pipeline', requirePermission('deal:read'), asyncHandler(async (req, res) => {
  const scope = ownerScopeClause(req, 'd.owner_id', { includeUnassigned: true });
  const params = [req.auth.organizationId, ...scope.params];
  const filters = [];
  if (req.query.ownerId) {
    assertRecordAccess(req, req.query.ownerId);
    filters.push('d.owner_id = ?');
    params.push(req.query.ownerId);
  }
  if (req.query.minValue) {
    filters.push('d.value >= ?');
    params.push(finiteNumber(req.query.minValue));
  }
  if (req.query.q) {
    filters.push('(d.name LIKE ? OR l.company_name LIKE ?)');
    params.push(`%${req.query.q}%`, `%${req.query.q}%`);
  }

  const rows = all(
    `SELECT d.*, l.first_name, l.last_name, l.company_name, l.temperature, u.name AS owner_name,
       (SELECT COUNT(*) FROM calls c WHERE c.deal_id = d.id OR c.lead_id = d.lead_id) AS call_count,
       (SELECT COUNT(*) FROM emails e WHERE e.deal_id = d.id OR e.lead_id = d.lead_id) AS email_count,
       (SELECT COUNT(*) FROM tasks t WHERE t.deal_id = d.id AND t.status = 'open') AS open_tasks,
       (SELECT MAX(c.started_at) FROM calls c WHERE c.lead_id = d.lead_id) AS last_call_at,
       (SELECT a.sentiment FROM call_analyses a JOIN calls c ON c.id = a.call_id
          WHERE c.lead_id = d.lead_id ORDER BY a.created_at DESC LIMIT 1) AS last_sentiment
     FROM deals d
     LEFT JOIN leads l ON l.id = d.lead_id
     LEFT JOIN users u ON u.id = d.owner_id
     WHERE d.organization_id = ?${scope.sql}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}
     ORDER BY d.position ASC, d.value DESC`,
    params,
  );

  // Risk assessment is joined in so the board can show health without a second
  // round trip -- the agent sees which cards need attention at a glance.
  const riskById = new Map(
    insights.dealsAtRisk({
      organizationId: req.auth.organizationId,
      ownerIds: visibleUserIds(req) === 'all' ? 'all' : visibleUserIds(req),
      limit: 200,
    }).map((d) => [d.dealId, d]),
  );

  const stages = PIPELINE_STAGES.map((stage) => {
    const deals = rows.filter((row) => row.stage === stage.key).map((row) => ({
      ...crm.dealView(row),
      callCount: row.call_count,
      emailCount: row.email_count,
      openTasks: row.open_tasks,
      lastCallAt: row.last_call_at,
      lastSentiment: row.last_sentiment,
      temperature: row.temperature,
      risk: riskById.get(row.id) ? {
        score: riskById.get(row.id).riskScore,
        health: riskById.get(row.id).health,
        reasons: riskById.get(row.id).reasons,
        recommendedAction: riskById.get(row.id).recommendedAction,
      } : null,
    }));
    return {
      ...stage,
      deals,
      count: deals.length,
      value: deals.reduce((sum, d) => sum + (d.value || 0), 0),
      weightedValue: deals.reduce((sum, d) => sum + (d.weightedValue || 0), 0),
    };
  });

  const open = stages.filter((s) => !s.terminal);
  res.json({
    stages,
    totals: {
      openDeals: open.reduce((sum, s) => sum + s.count, 0),
      openValue: open.reduce((sum, s) => sum + s.value, 0),
      weightedForecast: open.reduce((sum, s) => sum + s.weightedValue, 0),
      wonValue: stages.find((s) => s.key === 'won')?.value || 0,
      lostValue: stages.find((s) => s.key === 'lost')?.value || 0,
      atRisk: [...riskById.values()].filter((d) => d.health === 'at_risk').length,
    },
  });
}));

// GET /deals
router.get('/', requirePermission('deal:read'), asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 50 });
  const scope = ownerScopeClause(req, 'd.owner_id', { includeUnassigned: true });
  const params = [req.auth.organizationId, ...scope.params];
  const filters = [];
  if (req.query.stage) {
    filters.push('d.stage = ?');
    params.push(req.query.stage);
  }
  if (req.query.openOnly !== 'false') filters.push(`d.stage NOT IN ('won','lost')`);
  if (req.query.closingBefore) {
    filters.push('d.expected_close_date <= ?');
    params.push(req.query.closingBefore);
  }
  const where = `WHERE d.organization_id = ?${scope.sql}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`;
  const total = get(`SELECT COUNT(*) AS n FROM deals d ${where}`, params)?.n || 0;
  const rows = all(
    `SELECT d.*, l.first_name, l.last_name, l.company_name, u.name AS owner_name
     FROM deals d LEFT JOIN leads l ON l.id = d.lead_id LEFT JOIN users u ON u.id = d.owner_id
     ${where} ORDER BY d.value DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  res.json({ deals: rows.map(crm.dealView), total, limit, offset });
}));

// POST /deals
router.post('/', requirePermission('deal:write'), asyncHandler(async (req, res) => {
  const data = validate(req.body, DEAL_SCHEMA);
  // The same rule PATCH and /move enforce. Creating a deal already lost
  // skipped it, so a reason-less lost deal could be written on the one path
  // that never asks -- and win/loss analysis is the reason the field exists.
  if (data.stage === 'lost' && !data.lostReason) throw lostReasonRequired();
  if (data.leadId) {
    const lead = get('SELECT owner_id FROM leads WHERE id = ? AND organization_id = ?', [data.leadId, req.auth.organizationId]);
    if (!lead) throw notFound('Lead');
    assertRecordAccess(req, lead.owner_id);
  }
  const deal = crm.createDeal({ organizationId: req.auth.organizationId, data, actorId: req.auth.userId });
  res.status(201).json({ deal });
}));

// GET /deals/:id
router.get('/:dealId', requirePermission('deal:read'), asyncHandler(async (req, res) => {
  const deal = get(
    `SELECT d.*, l.first_name, l.last_name, l.company_name, l.email, l.phone_e164, l.temperature, u.name AS owner_name
     FROM deals d LEFT JOIN leads l ON l.id = d.lead_id LEFT JOIN users u ON u.id = d.owner_id
     WHERE d.id = ? AND d.organization_id = ?`,
    [req.params.dealId, req.auth.organizationId],
  );
  if (!deal) throw notFound('Deal');
  assertRecordAccess(req, deal.owner_id);

  const risk = insights.dealsAtRisk({ organizationId: req.auth.organizationId, ownerIds: 'all', limit: 500 })
    .find((d) => d.dealId === deal.id) || null;

  res.json({
    deal: crm.dealView(deal),
    contact: deal.lead_id ? {
      leadId: deal.lead_id,
      name: `${deal.first_name || ''} ${deal.last_name || ''}`.trim(),
      company: deal.company_name,
      email: deal.email,
      phone: deal.phone_e164,
      temperature: deal.temperature,
    } : null,
    risk,
    stageHistory: all(
      `SELECT h.*, u.name AS changed_by_name FROM deal_stage_history h
       LEFT JOIN users u ON u.id = h.changed_by WHERE h.deal_id = ? ORDER BY h.created_at ASC`,
      [deal.id],
    ),
    calls: all(
      `SELECT c.id, c.started_at, c.duration_seconds, c.outcome, a.summary, a.sentiment
       FROM calls c LEFT JOIN call_analyses a ON a.call_id = c.id
       WHERE c.deal_id = ? OR c.lead_id = ? ORDER BY c.started_at DESC LIMIT 15`,
      [deal.id, deal.lead_id],
    ),
    emails: all(
      `SELECT id, subject, status, sent_at, template FROM emails WHERE deal_id = ? OR lead_id = ?
       ORDER BY created_at DESC LIMIT 15`,
      [deal.id, deal.lead_id],
    ),
    tasks: all(`SELECT * FROM tasks WHERE deal_id = ? ORDER BY due_at ASC LIMIT 20`, [deal.id]),
    notes: all(`SELECT n.*, u.name AS author_name FROM notes n LEFT JOIN users u ON u.id = n.author_id
                WHERE n.deal_id = ? ORDER BY n.created_at DESC LIMIT 20`, [deal.id]),
    timeline: activityService.timeline({ organizationId: req.auth.organizationId, dealId: deal.id, limit: 40 })
      .map((item) => ({ ...item, metadata: parseJson(item.metadata, {}) })),
    aiSuggestions: (await import('../services/ai/extraction.js')).listSuggestions({
      organizationId: req.auth.organizationId, ownerIds: visibleUserIds(req), entityType: 'deal', entityId: deal.id, status: 'pending',
    }),
  });
}));

// PATCH /deals/:id
router.patch('/:dealId', requirePermission('deal:write'), asyncHandler(async (req, res) => {
  const existing = get('SELECT owner_id, stage FROM deals WHERE id = ? AND organization_id = ?', [req.params.dealId, req.auth.organizationId]);
  if (!existing) throw notFound('Deal');
  assertRecordAccess(req, existing.owner_id);
  const patch = validate(req.body, DEAL_SCHEMA, { partial: true });
  if (patch.stage === 'lost' && !patch.lostReason) {
    const current = get('SELECT lost_reason FROM deals WHERE id = ?', [req.params.dealId]);
    if (!current?.lost_reason) throw lostReasonRequired();
  }
  const deal = crm.updateDeal({
    organizationId: req.auth.organizationId, dealId: req.params.dealId, patch, actorId: req.auth.userId,
  });
  res.json({ deal });
}));

// POST /deals/:id/move  -- drag-and-drop on the board
router.post('/:dealId/move', requirePermission('deal:write'), asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    stage: { type: 'string', required: true, enum: STAGE_KEYS },
    position: { type: 'number', integer: true, min: 0 },
    lostReason: { type: 'string', maxLength: 300 },
  });
  const existing = get('SELECT * FROM deals WHERE id = ? AND organization_id = ?', [req.params.dealId, req.auth.organizationId]);
  if (!existing) throw notFound('Deal');
  assertRecordAccess(req, existing.owner_id);
  if (body.stage === 'lost' && !body.lostReason && !existing.lost_reason) throw lostReasonRequired();
  const deal = crm.updateDeal({
    organizationId: req.auth.organizationId,
    dealId: req.params.dealId,
    patch: { stage: body.stage, position: body.position, lostReason: body.lostReason },
    actorId: req.auth.userId,
  });
  return res.json({ deal, stage: STAGE_MAP[body.stage] });
}));

// POST /deals/reorder  -- persist card order within a stage
router.post('/reorder', requirePermission('deal:write'), asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    stage: { type: 'string', required: true, enum: STAGE_KEYS },
    dealIds: { type: 'array', of: 'string', required: true, maxItems: 500 },
  });
  body.dealIds.forEach((dealId, index) => {
    run('UPDATE deals SET position = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND stage = ?',
      [index + 1, nowIso(), dealId, req.auth.organizationId, body.stage]);
  });
  res.json({ ok: true, ordered: body.dealIds.length });
}));

// GET /deals/:id/velocity  -- how long this deal spent in each stage
router.get('/:dealId/velocity', requirePermission('deal:read'), asyncHandler(async (req, res) => {
  const history = all('SELECT * FROM deal_stage_history WHERE deal_id = ? ORDER BY created_at ASC', [req.params.dealId]);
  if (!history.length) throw notFound('Deal');
  const segments = history.map((entry, index) => {
    const next = history[index + 1];
    const endedAt = next ? next.created_at : nowIso();
    return {
      stage: entry.to_stage,
      label: STAGE_MAP[entry.to_stage]?.label || entry.to_stage,
      enteredAt: entry.created_at,
      exitedAt: next ? next.created_at : null,
      days: Math.max(0, Math.round((new Date(endedAt) - new Date(entry.created_at)) / 86400000)),
      source: entry.source,
    };
  });
  res.json({ segments, totalDays: segments.reduce((sum, s) => sum + s.days, 0) });
}));

export default router;
