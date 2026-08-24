import { Router } from 'express';
import { all, get, insert, run, parseJson } from '../db/index.js';
import { id } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { validate, parsePagination, EMAIL_PATTERN } from '../lib/validate.js';
import { EMAIL_TEMPLATES } from '../lib/constants.js';
import { notFound, badRequest } from '../lib/errors.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requirePermission, ownerScopeClause, assertRecordAccess } from '../middleware/auth.js';
import { enqueue } from '../services/queue/index.js';
import * as audit from '../services/audit.js';
import * as activityService from '../services/activity.js';

const router = Router();

function emailView(row) {
  return {
    id: row.id,
    leadId: row.lead_id,
    dealId: row.deal_id,
    callId: row.call_id,
    userId: row.user_id,
    direction: row.direction,
    template: row.template,
    to: row.to_address,
    cc: parseJson(row.cc, []),
    subject: row.subject,
    body: row.body,
    bodyFormat: row.body_format,
    status: row.status,
    generatedByAi: Boolean(row.generated_by_ai),
    editedByHuman: Boolean(row.edited_by_human),
    provider: row.provider,
    sentAt: row.sent_at,
    openedAt: row.opened_at,
    repliedAt: row.replied_at,
    error: row.error,
    createdAt: row.created_at,
    contactName: row.first_name ? `${row.first_name} ${row.last_name || ''}`.trim() : undefined,
    companyName: row.company_name,
    senderName: row.sender_name,
  };
}

// GET /emails
router.get('/', requirePermission('email:read'), asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 40 });
  const scope = ownerScopeClause(req, 'e.user_id', { includeUnassigned: true });
  const params = [req.auth.organizationId, ...scope.params];
  const filters = [];
  if (req.query.status) {
    filters.push('e.status = ?');
    params.push(req.query.status);
  }
  if (req.query.leadId) {
    filters.push('e.lead_id = ?');
    params.push(req.query.leadId);
  }
  if (req.query.aiOnly === 'true') filters.push('e.generated_by_ai = 1');
  const where = `WHERE e.organization_id = ?${scope.sql}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`;
  const total = get(`SELECT COUNT(*) AS n FROM emails e ${where}`, params)?.n || 0;
  const rows = all(
    `SELECT e.*, l.first_name, l.last_name, l.company_name, u.name AS sender_name
     FROM emails e LEFT JOIN leads l ON l.id = e.lead_id LEFT JOIN users u ON u.id = e.user_id
     ${where} ORDER BY COALESCE(e.sent_at, e.created_at) DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  res.json({ emails: rows.map(emailView), total, limit, offset, templates: EMAIL_TEMPLATES });
}));

const EMAIL_SCHEMA = {
  leadId: { type: 'string', maxLength: 40 },
  dealId: { type: 'string', maxLength: 40 },
  callId: { type: 'string', maxLength: 40 },
  to: { type: 'string', maxLength: 200, pattern: EMAIL_PATTERN, message: 'must be a valid email address' },
  cc: { type: 'array', of: 'string', maxItems: 10 },
  subject: { type: 'string', maxLength: 300 },
  body: { type: 'string', maxLength: 100000 },
  bodyFormat: { type: 'string', enum: ['text', 'html'], default: 'text' },
  template: { type: 'string', enum: EMAIL_TEMPLATES.map((t) => t.key) },
  generatedByAi: { type: 'boolean', default: false },
  aiMetadata: { type: 'object' },
};

// POST /emails  -- save a draft (from the AI generator or written by hand)
router.post('/', requirePermission('email:send'), asyncHandler(async (req, res) => {
  const data = validate(req.body, EMAIL_SCHEMA, { partial: true });
  let to = data.to;
  if (!to && data.leadId) {
    const lead = get('SELECT email, owner_id FROM leads WHERE id = ? AND organization_id = ?', [data.leadId, req.auth.organizationId]);
    if (!lead) throw notFound('Lead');
    assertRecordAccess(req, lead.owner_id);
    to = lead.email;
  }
  if (!to) throw badRequest('A recipient address is required');

  const row = {
    id: id('eml'),
    organization_id: req.auth.organizationId,
    lead_id: data.leadId || null,
    deal_id: data.dealId || null,
    call_id: data.callId || null,
    user_id: req.auth.userId,
    direction: 'outbound',
    template: data.template || null,
    to_address: to,
    cc: JSON.stringify(data.cc || []),
    subject: data.subject || '(no subject)',
    body: data.body || '',
    body_format: data.bodyFormat || 'text',
    status: 'draft',
    generated_by_ai: data.generatedByAi ? 1 : 0,
    ai_metadata: JSON.stringify(data.aiMetadata || {}),
    edited_by_human: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('emails', row);
  res.status(201).json({ email: emailView(row) });
}));

// PATCH /emails/:id  -- editing an AI draft records that a human intervened
router.patch('/:emailId', requirePermission('email:send'), asyncHandler(async (req, res) => {
  const existing = get('SELECT * FROM emails WHERE id = ? AND organization_id = ?', [req.params.emailId, req.auth.organizationId]);
  if (!existing) throw notFound('Email');
  if (existing.status === 'sent') throw badRequest('A sent email cannot be edited');
  assertRecordAccess(req, existing.user_id);

  const patch = validate(req.body, EMAIL_SCHEMA, { partial: true });
  const columns = {
    to_address: patch.to,
    cc: patch.cc ? JSON.stringify(patch.cc) : undefined,
    subject: patch.subject,
    body: patch.body,
    body_format: patch.bodyFormat,
    template: patch.template,
  };
  const bodyChanged = (patch.body !== undefined && patch.body !== existing.body)
    || (patch.subject !== undefined && patch.subject !== existing.subject);
  if (bodyChanged && existing.generated_by_ai) columns.edited_by_human = 1;

  const keys = Object.keys(columns).filter((k) => columns[k] !== undefined);
  if (keys.length) {
    run(`UPDATE emails SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => columns[k]), nowIso(), existing.id]);
  }
  res.json({ email: emailView(get('SELECT * FROM emails WHERE id = ?', [existing.id])) });
}));

// POST /emails/:id/send
router.post('/:emailId/send', requirePermission('email:send'), asyncHandler(async (req, res) => {
  const email = get('SELECT * FROM emails WHERE id = ? AND organization_id = ?', [req.params.emailId, req.auth.organizationId]);
  if (!email) throw notFound('Email');
  if (email.status === 'sent') return res.json({ email: emailView(email), alreadySent: true });
  if (!email.to_address) throw badRequest('This draft has no recipient');
  assertRecordAccess(req, email.user_id);

  run(`UPDATE emails SET status = 'queued', updated_at = ? WHERE id = ?`, [nowIso(), email.id]);
  const jobId = enqueue('email.send', { emailId: email.id }, { organizationId: req.auth.organizationId, priority: 3 });

  audit.recordFromRequest(req, {
    action: 'email.send', entityType: 'email', entityId: email.id,
    after: { to: email.to_address, subject: email.subject, generatedByAi: Boolean(email.generated_by_ai) },
  });

  return res.status(202).json({ queued: true, jobId, email: emailView(get('SELECT * FROM emails WHERE id = ?', [email.id])) });
}));

// GET /emails/:id
router.get('/:emailId', requirePermission('email:read'), asyncHandler(async (req, res) => {
  const email = get(
    `SELECT e.*, l.first_name, l.last_name, l.company_name, u.name AS sender_name
     FROM emails e LEFT JOIN leads l ON l.id = e.lead_id LEFT JOIN users u ON u.id = e.user_id
     WHERE e.id = ? AND e.organization_id = ?`,
    [req.params.emailId, req.auth.organizationId],
  );
  if (!email) throw notFound('Email');
  assertRecordAccess(req, email.user_id);
  res.json({ email: emailView(email), aiMetadata: parseJson(email.ai_metadata, {}) });
}));

// DELETE /emails/:id  -- discard a draft
router.delete('/:emailId', requirePermission('email:send'), asyncHandler(async (req, res) => {
  const email = get('SELECT * FROM emails WHERE id = ? AND organization_id = ?', [req.params.emailId, req.auth.organizationId]);
  if (!email) throw notFound('Email');
  if (email.status === 'sent') throw badRequest('A sent email cannot be deleted');
  run('DELETE FROM emails WHERE id = ?', [email.id]);
  res.json({ ok: true });
}));

// POST /emails/:id/log-reply  -- record an inbound reply against the thread
router.post('/:emailId/log-reply', requirePermission('email:send'), asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    body: { type: 'string', required: true, maxLength: 50000 },
    subject: { type: 'string', maxLength: 300 },
    receivedAt: { type: 'date' },
  });
  const original = get('SELECT * FROM emails WHERE id = ? AND organization_id = ?', [req.params.emailId, req.auth.organizationId]);
  if (!original) throw notFound('Email');

  const reply = {
    id: id('eml'),
    organization_id: req.auth.organizationId,
    lead_id: original.lead_id,
    deal_id: original.deal_id,
    call_id: original.call_id,
    user_id: original.user_id,
    direction: 'inbound',
    to_address: original.to_address,
    cc: '[]',
    subject: body.subject || `Re: ${original.subject}`,
    body: body.body,
    body_format: 'text',
    status: 'received',
    generated_by_ai: 0,
    ai_metadata: '{}',
    edited_by_human: 0,
    sent_at: body.receivedAt || nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('emails', reply);
  run('UPDATE emails SET replied_at = ? WHERE id = ?', [reply.sent_at, original.id]);

  activityService.log({
    organizationId: req.auth.organizationId,
    leadId: original.lead_id,
    dealId: original.deal_id,
    actorId: req.auth.userId,
    type: 'email',
    refId: reply.id,
    title: `Reply received: ${reply.subject}`,
    body: body.body.slice(0, 400),
    occurredAt: reply.sent_at,
  });
  res.status(201).json({ email: emailView(reply) });
}));

export default router;
