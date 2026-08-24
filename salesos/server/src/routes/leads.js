import { Router } from 'express';
import { all, get, run, parseJson } from '../db/index.js';
import { validate, parsePagination, parseSort, EMAIL_PATTERN } from '../lib/validate.js';
import { LEAD_STATUSES, LEAD_TEMPERATURES, LEAD_SOURCES } from '../lib/constants.js';
import { notFound, badRequest, forbidden } from '../lib/errors.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requirePermission, ownerScopeClause, assertRecordAccess, visibleUserIds } from '../middleware/auth.js';
import * as crm from '../services/crm.js';
import * as activityService from '../services/activity.js';
import * as audit from '../services/audit.js';
import { enqueue } from '../services/queue/index.js';
import { nowIso } from '../lib/time.js';

const router = Router();

const SORTABLE = ['created_at', 'updated_at', 'score', 'deal_value', 'last_contacted_at', 'next_follow_up_at', 'first_name', 'company_name'];

// GET /leads
router.get('/', requirePermission('lead:read'), asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
  const order = parseSort(req.query, SORTABLE, 'updated_at DESC');
  const scope = ownerScopeClause(req, 'l.owner_id', { includeUnassigned: true });

  const filters = [];
  const params = [req.auth.organizationId, ...scope.params];
  const where = () => `WHERE l.organization_id = ?${scope.sql} AND l.archived_at IS NULL${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`;

  const addFilter = (clause, value) => {
    filters.push(clause);
    params.push(value);
  };
  if (req.query.status) addFilter('l.status = ?', req.query.status);
  if (req.query.temperature) addFilter('l.temperature = ?', req.query.temperature);
  if (req.query.source) addFilter('l.source = ?', req.query.source);
  if (req.query.industry) addFilter('l.industry = ?', req.query.industry);
  if (req.query.ownerId) {
    assertRecordAccess(req, req.query.ownerId);
    addFilter('l.owner_id = ?', req.query.ownerId);
  }
  if (req.query.minScore) addFilter('l.score >= ?', Number(req.query.minScore));
  if (req.query.tag) addFilter('EXISTS (SELECT 1 FROM json_each(l.tags) WHERE json_each.value = ?)', req.query.tag);
  if (req.query.followUpBefore) addFilter('l.next_follow_up_at <= ?', req.query.followUpBefore);
  if (req.query.notContactedSince) addFilter('(l.last_contacted_at IS NULL OR l.last_contacted_at < ?)', req.query.notContactedSince);
  if (req.query.q) {
    filters.push('(l.first_name LIKE ? OR l.last_name LIKE ? OR l.company_name LIKE ? OR l.email LIKE ? OR l.phone_e164 LIKE ?)');
    const like = `%${req.query.q}%`;
    params.push(like, like, like, like, like);
  }

  const total = get(`SELECT COUNT(*) AS n FROM leads l ${where()}`, params)?.n || 0;
  const rows = all(
    `SELECT l.*, u.name AS owner_name,
       (SELECT COUNT(*) FROM calls c WHERE c.lead_id = l.id) AS call_count,
       (SELECT COUNT(*) FROM tasks t WHERE t.lead_id = l.id AND t.status = 'open') AS open_tasks,
       d.id AS deal_id, d.stage AS deal_stage, d.value AS deal_amount
     FROM leads l
     LEFT JOIN users u ON u.id = l.owner_id
     LEFT JOIN deals d ON d.lead_id = l.id AND d.stage NOT IN ('won','lost')
     ${where()}
     GROUP BY l.id ORDER BY l.${order} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  res.json({
    leads: rows.map((row) => ({
      ...crm.leadView(row),
      callCount: row.call_count,
      openTasks: row.open_tasks,
      deal: row.deal_id ? { id: row.deal_id, stage: row.deal_stage, value: row.deal_amount } : null,
    })),
    total,
    limit,
    offset,
  });
}));

// GET /leads/facets -- values available for filtering, scoped to the caller.
router.get('/facets', requirePermission('lead:read'), asyncHandler(async (req, res) => {
  const scope = ownerScopeClause(req, 'owner_id', { includeUnassigned: true });
  const params = [req.auth.organizationId, ...scope.params];
  const bucket = (column) => all(
    `SELECT ${column} AS value, COUNT(*) AS count FROM leads
     WHERE organization_id = ?${scope.sql} AND archived_at IS NULL AND ${column} IS NOT NULL
     GROUP BY ${column} ORDER BY count DESC`,
    params,
  );
  res.json({
    status: bucket('status'),
    temperature: bucket('temperature'),
    source: bucket('source'),
    industry: bucket('industry'),
    owners: all(
      `SELECT l.owner_id AS value, u.name AS label, COUNT(*) AS count FROM leads l
       LEFT JOIN users u ON u.id = l.owner_id
       WHERE l.organization_id = ?${scope.sql} AND l.archived_at IS NULL
       GROUP BY l.owner_id ORDER BY count DESC`,
      params,
    ),
    tags: all(
      `SELECT json_each.value AS value, COUNT(*) AS count FROM leads l, json_each(l.tags)
       WHERE l.organization_id = ?${scope.sql} AND l.archived_at IS NULL
       GROUP BY json_each.value ORDER BY count DESC LIMIT 40`,
      params,
    ),
    options: { statuses: LEAD_STATUSES, temperatures: LEAD_TEMPERATURES, sources: LEAD_SOURCES },
  });
}));

const LEAD_SCHEMA = {
  firstName: { type: 'string', required: true, maxLength: 80 },
  lastName: { type: 'string', maxLength: 80 },
  companyName: { type: 'string', maxLength: 160 },
  jobTitle: { type: 'string', maxLength: 120 },
  phone: { type: 'string', maxLength: 40 },
  secondaryPhone: { type: 'string', maxLength: 40 },
  email: { type: 'string', maxLength: 200, pattern: EMAIL_PATTERN, message: 'must be a valid email address' },
  location: { type: 'string', maxLength: 160 },
  country: { type: 'string', maxLength: 4 },
  timezone: { type: 'string', maxLength: 60 },
  source: { type: 'string', enum: LEAD_SOURCES },
  industry: { type: 'string', maxLength: 100 },
  status: { type: 'string', enum: LEAD_STATUSES },
  temperature: { type: 'string', enum: LEAD_TEMPERATURES },
  score: { type: 'number', min: 0, max: 100, integer: true },
  tags: { type: 'array', of: 'string', maxItems: 20 },
  ownerId: { type: 'string', maxLength: 40 },
  dealValue: { type: 'number', min: 0 },
  expectedCloseDate: { type: 'date' },
  nextFollowUpAt: { type: 'date' },
  doNotCall: { type: 'boolean' },
  consentRecording: { type: 'string', enum: ['granted', 'denied', 'unknown'] },
  customFields: { type: 'object' },
  createDeal: { type: 'boolean' },
  product: { type: 'string', maxLength: 120 },
};

// POST /leads
router.post('/', requirePermission('lead:write'), asyncHandler(async (req, res) => {
  const data = validate(req.body, LEAD_SCHEMA);
  if (data.ownerId) assertRecordAccess(req, data.ownerId);
  const result = crm.createLead({
    organizationId: req.auth.organizationId,
    data,
    actorId: req.auth.userId,
    allowDuplicate: req.query.allowDuplicate === 'true',
  });
  res.status(201).json(result);
}));

// POST /leads/check-duplicate
router.post('/check-duplicate', requirePermission('lead:read'), asyncHandler(async (req, res) => {
  const data = validate(req.body, {
    email: { type: 'string', maxLength: 200 },
    phone: { type: 'string', maxLength: 40 },
    firstName: { type: 'string', maxLength: 80 },
    lastName: { type: 'string', maxLength: 80 },
    companyName: { type: 'string', maxLength: 160 },
  }, { partial: true });
  const { toE164 } = await import('../lib/phone.js');
  const phoneE164 = data.phone ? toE164(data.phone) : null;
  const dedupeKey = crm.dedupeKeyFor({ ...data, phoneE164 });
  const duplicate = crm.findDuplicate({ organizationId: req.auth.organizationId, dedupeKey, email: data.email, phoneE164 });
  res.json({
    duplicate: duplicate ? crm.leadView(duplicate) : null,
    matchedOn: duplicate ? (dedupeKey?.split(':')[0] || 'unknown') : null,
  });
}));

// POST /leads/import  -- accepts parsed rows or raw CSV text
router.post('/import', requirePermission('lead:import'), asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    csv: { type: 'string', maxLength: 8_000_000 },
    rows: { type: 'array', maxItems: 20000 },
    allowDuplicates: { type: 'boolean', default: false },
    async: { type: 'boolean', default: false },
  }, { partial: true });

  let rows = body.rows || [];
  let headers = [];
  if (body.csv) {
    const parsed = crm.parseCsv(body.csv);
    rows = parsed.rows;
    headers = parsed.headers;
  }
  if (!rows.length) throw badRequest('No rows to import. Provide `csv` text or a `rows` array.');

  // Large files go through the queue so the request returns immediately.
  if (body.async || rows.length > 500) {
    const jobId = enqueue('lead.import_batch', {
      organizationId: req.auth.organizationId, rows, actorId: req.auth.userId,
    }, { organizationId: req.auth.organizationId, priority: 4, maxAttempts: 1 });
    return res.status(202).json({ queued: true, jobId, rows: rows.length, headers });
  }

  const result = crm.importLeads({
    organizationId: req.auth.organizationId,
    rows,
    actorId: req.auth.userId,
    allowDuplicates: body.allowDuplicates,
  });
  return res.json({ ...result, headers });
}));

// POST /leads/import/preview -- header mapping and validation, no writes
router.post('/import/preview', requirePermission('lead:import'), asyncHandler(async (req, res) => {
  const body = validate(req.body, { csv: { type: 'string', required: true, maxLength: 8_000_000 } });
  const { headers, rows } = crm.parseCsv(body.csv);
  const sample = rows.slice(0, 10).map((row, index) => {
    const normalised = crm.normaliseImportRow(row);
    const problems = [];
    if (!normalised.firstName) problems.push('missing name');
    if (!normalised.email && !normalised.phone) problems.push('missing email and phone');
    return { row: index + 1, normalised, problems };
  });
  const duplicatesInFile = new Set();
  const seen = new Set();
  for (const row of rows) {
    const normalised = crm.normaliseImportRow(row);
    const key = crm.dedupeKeyFor({ email: normalised.email, phoneE164: normalised.phone, ...normalised });
    if (key && seen.has(key)) duplicatesInFile.add(key);
    if (key) seen.add(key);
  }
  res.json({ headers, totalRows: rows.length, sample, duplicatesWithinFile: duplicatesInFile.size });
}));

// POST /leads/bulk
router.post('/bulk', requirePermission('lead:write'), asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    leadIds: { type: 'array', of: 'string', required: true, maxItems: 1000 },
    action: { type: 'string', required: true, enum: ['assign', 'update', 'archive', 'tag', 'untag'] },
    ownerId: { type: 'string' },
    patch: { type: 'object' },
    tags: { type: 'array', of: 'string' },
  });

  if (body.action === 'assign') {
    if (!body.ownerId) throw badRequest('ownerId is required to assign leads');
    const { can } = await import('../lib/permissions.js');
    if (!can(req.auth.role, 'lead:assign')) throw forbidden('Only managers and above can reassign leads');
    const result = crm.bulkUpdateLeads({
      organizationId: req.auth.organizationId, leadIds: body.leadIds,
      patch: { ownerId: body.ownerId }, actorId: req.auth.userId,
    });
    return res.json(result);
  }

  if (body.action === 'archive') {
    let archived = 0;
    for (const leadId of body.leadIds) {
      const lead = get('SELECT owner_id FROM leads WHERE id = ? AND organization_id = ?', [leadId, req.auth.organizationId]);
      if (!lead) continue;
      assertRecordAccess(req, lead.owner_id);
      crm.archiveLead({ organizationId: req.auth.organizationId, leadId, actorId: req.auth.userId });
      archived += 1;
    }
    return res.json({ archived });
  }

  if (body.action === 'tag' || body.action === 'untag') {
    if (!body.tags?.length) throw badRequest('tags is required');
    let updated = 0;
    for (const leadId of body.leadIds) {
      const lead = get('SELECT * FROM leads WHERE id = ? AND organization_id = ?', [leadId, req.auth.organizationId]);
      if (!lead) continue;
      assertRecordAccess(req, lead.owner_id);
      const current = parseJson(lead.tags, []);
      const next = body.action === 'tag'
        ? [...new Set([...current, ...body.tags])]
        : current.filter((tag) => !body.tags.includes(tag));
      crm.updateLead({ organizationId: req.auth.organizationId, leadId, patch: { tags: next }, actorId: req.auth.userId, source: 'bulk' });
      updated += 1;
    }
    return res.json({ updated });
  }

  const result = crm.bulkUpdateLeads({
    organizationId: req.auth.organizationId, leadIds: body.leadIds, patch: body.patch || {}, actorId: req.auth.userId,
  });
  return res.json(result);
}));

// GET /leads/:id
router.get('/:leadId', requirePermission('lead:read'), asyncHandler(async (req, res) => {
  const lead = get(
    `SELECT l.*, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id = l.owner_id
     WHERE l.id = ? AND l.organization_id = ?`,
    [req.params.leadId, req.auth.organizationId],
  );
  if (!lead) throw notFound('Lead');
  assertRecordAccess(req, lead.owner_id);

  const deals = all(
    `SELECT d.*, u.name AS owner_name FROM deals d LEFT JOIN users u ON u.id = d.owner_id
     WHERE d.lead_id = ? ORDER BY CASE WHEN d.stage IN ('won','lost') THEN 1 ELSE 0 END, d.updated_at DESC`,
    [lead.id],
  );
  const calls = all(
    `SELECT c.*, a.summary, a.sentiment, a.id AS analysis_id,
            (SELECT id FROM transcripts t WHERE t.call_id = c.id LIMIT 1) AS transcript_id
     FROM calls c LEFT JOIN call_analyses a ON a.call_id = c.id
     WHERE c.lead_id = ? ORDER BY c.started_at DESC LIMIT 25`,
    [lead.id],
  );

  res.json({
    lead: crm.leadView(lead, { includeInternal: true }),
    deals: deals.map(crm.dealView),
    calls: calls.map((call) => ({
      id: call.id,
      direction: call.direction,
      status: call.status,
      outcome: call.outcome,
      startedAt: call.started_at,
      durationSeconds: call.duration_seconds,
      talkSeconds: call.talk_seconds,
      hasRecording: Boolean(call.recording_object_key),
      aiStatus: call.ai_status,
      analysisId: call.analysis_id,
      transcriptId: call.transcript_id,
      summary: call.summary,
      sentiment: call.sentiment,
      notes: call.notes,
    })),
    tasks: all(
      `SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.lead_id = ? ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 0 ELSE 1 END, t.due_at ASC LIMIT 25`,
      [lead.id],
    ),
    emails: all(
      `SELECT id, subject, status, template, generated_by_ai, edited_by_human, sent_at, created_at, to_address
       FROM emails WHERE lead_id = ? ORDER BY created_at DESC LIMIT 25`,
      [lead.id],
    ),
    meetings: all('SELECT * FROM meetings WHERE lead_id = ? ORDER BY starts_at DESC LIMIT 20', [lead.id]),
    notes: all(
      `SELECT n.*, u.name AS author_name FROM notes n LEFT JOIN users u ON u.id = n.author_id
       WHERE n.lead_id = ? ORDER BY n.pinned DESC, n.created_at DESC LIMIT 50`,
      [lead.id],
    ),
    messages: all('SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at DESC LIMIT 30', [lead.id]),
    pendingSuggestions: (await import('../services/ai/extraction.js')).listSuggestions({
      organizationId: req.auth.organizationId, ownerIds: visibleUserIds(req), entityType: 'lead', entityId: lead.id, status: 'pending',
    }),
  });
}));

// PATCH /leads/:id
router.patch('/:leadId', requirePermission('lead:write'), asyncHandler(async (req, res) => {
  const existing = get('SELECT owner_id FROM leads WHERE id = ? AND organization_id = ?', [req.params.leadId, req.auth.organizationId]);
  if (!existing) throw notFound('Lead');
  assertRecordAccess(req, existing.owner_id);

  const patch = validate(req.body, LEAD_SCHEMA, { partial: true });
  if (patch.ownerId && patch.ownerId !== existing.owner_id) {
    const { can } = await import('../lib/permissions.js');
    if (!can(req.auth.role, 'lead:assign')) throw forbidden('Only managers and above can reassign leads');
  }
  const lead = crm.updateLead({
    organizationId: req.auth.organizationId, leadId: req.params.leadId, patch, actorId: req.auth.userId,
  });
  res.json({ lead });
}));

// DELETE /leads/:id  (archive; hard delete is an admin-only data operation)
router.delete('/:leadId', requirePermission('lead:delete'), asyncHandler(async (req, res) => {
  crm.archiveLead({ organizationId: req.auth.organizationId, leadId: req.params.leadId, actorId: req.auth.userId });
  res.json({ ok: true });
}));

// GET /leads/:id/timeline
router.get('/:leadId/timeline', requirePermission('lead:read'), asyncHandler(async (req, res) => {
  const lead = get('SELECT owner_id FROM leads WHERE id = ? AND organization_id = ?', [req.params.leadId, req.auth.organizationId]);
  if (!lead) throw notFound('Lead');
  assertRecordAccess(req, lead.owner_id);
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 60, maxLimit: 200 });
  const types = req.query.types ? String(req.query.types).split(',') : null;
  const items = activityService.timeline({
    organizationId: req.auth.organizationId, leadId: req.params.leadId, types, limit, offset,
  });
  res.json({
    timeline: items.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      body: item.body,
      actorId: item.actor_id,
      actorType: item.actor_type,
      refId: item.ref_id,
      metadata: parseJson(item.metadata, {}),
      occurredAt: item.occurred_at,
    })),
    limit,
    offset,
  });
}));

// GET /leads/:id/audit
router.get('/:leadId/audit', requirePermission('lead:read'), asyncHandler(async (req, res) => {
  const entries = audit.list({
    organizationId: req.auth.organizationId, entityType: 'lead', entityId: req.params.leadId, limit: 100,
  });
  res.json({ audit: entries.map((entry) => ({ ...entry, diff: parseJson(entry.diff, null) })) });
}));

// POST /leads/:id/follow-up  -- quick "schedule follow-up" action
router.post('/:leadId/follow-up', requirePermission('lead:write'), asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    at: { type: 'date', required: true },
    createTask: { type: 'boolean', default: true },
    note: { type: 'string', maxLength: 500 },
  });
  const lead = get('SELECT * FROM leads WHERE id = ? AND organization_id = ?', [req.params.leadId, req.auth.organizationId]);
  if (!lead) throw notFound('Lead');
  assertRecordAccess(req, lead.owner_id);

  run('UPDATE leads SET next_follow_up_at = ?, updated_at = ? WHERE id = ?', [body.at, nowIso(), lead.id]);
  let task = null;
  if (body.createTask) {
    const automation = await import('../services/automation/index.js');
    task = automation.createTask({
      organizationId: req.auth.organizationId,
      title: `Follow up with ${lead.first_name} ${lead.last_name || ''}`.trim(),
      description: body.note || null,
      type: 'follow_up',
      dueAt: body.at,
      leadId: lead.id,
      assigneeId: lead.owner_id || req.auth.userId,
      createdBy: req.auth.userId,
    });
  }
  res.json({ nextFollowUpAt: body.at, task });
}));

export default router;
