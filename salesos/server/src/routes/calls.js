import { Router } from 'express';
import { all, get, run, parseJson } from '../db/index.js';
import { validate, parsePagination } from '../lib/validate.js';
import { CALL_OUTCOMES } from '../lib/constants.js';
import { notFound, badRequest, forbidden } from '../lib/errors.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requirePermission, ownerScopeClause, assertRecordAccess } from '../middleware/auth.js';
import * as telephony from '../services/telephony/index.js';
import * as crm from '../services/crm.js';
import { getObject, headObject } from '../services/storage/index.js';
import { orgSettings } from '../services/org.js';
import { formatDisplay, maskNumber } from '../lib/phone.js';
import { nowIso } from '../lib/time.js';
import * as audit from '../services/audit.js';
import config from '../config.js';

const router = Router();

// GET /calls
router.get('/', requirePermission('call:read'), asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
  const scope = ownerScopeClause(req, 'c.agent_id', { includeUnassigned: true });
  const filters = [];
  const params = [req.auth.organizationId, ...scope.params];
  const add = (clause, value) => {
    filters.push(clause);
    params.push(value);
  };
  if (req.query.status) add('c.status = ?', req.query.status);
  if (req.query.direction) add('c.direction = ?', req.query.direction);
  if (req.query.outcome) add('c.outcome = ?', req.query.outcome);
  if (req.query.leadId) add('c.lead_id = ?', req.query.leadId);
  if (req.query.agentId) {
    assertRecordAccess(req, req.query.agentId);
    add('c.agent_id = ?', req.query.agentId);
  }
  if (req.query.since) add('c.started_at >= ?', req.query.since);
  if (req.query.until) add('c.started_at <= ?', req.query.until);
  if (req.query.hasRecording === 'true') filters.push('c.recording_object_key IS NOT NULL');
  if (req.query.analysed === 'true') filters.push(`c.ai_status = 'complete'`);

  const where = `WHERE c.organization_id = ?${scope.sql}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`;
  const total = get(`SELECT COUNT(*) AS n FROM calls c ${where}`, params)?.n || 0;
  const rows = all(
    `SELECT c.*, u.name AS agent_name, l.first_name, l.last_name, l.company_name,
            a.id AS analysis_id, a.summary, a.sentiment, json_extract(a.scorecard, '$.overall') AS call_score
     FROM calls c
     LEFT JOIN users u ON u.id = c.agent_id
     LEFT JOIN leads l ON l.id = c.lead_id
     LEFT JOIN call_analyses a ON a.call_id = c.id
     ${where} ORDER BY c.started_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  res.json({
    calls: rows.map((row) => ({
      ...telephony.toView(row),
      agentName: row.agent_name,
      contactName: row.first_name ? `${row.first_name} ${row.last_name || ''}`.trim() : null,
      companyName: row.company_name,
      displayNumber: formatDisplay(row.direction === 'inbound' ? row.from_number : row.to_number),
      analysisId: row.analysis_id,
      summary: row.summary,
      sentiment: row.sentiment,
      callScore: row.call_score,
    })),
    total,
    limit,
    offset,
  });
}));

// GET /calls/active -- what the call dock should show on load
router.get('/active', requirePermission('call:read'), asyncHandler(async (req, res) => {
  res.json({ calls: telephony.activeCallsFor(req.auth.organizationId, req.auth.userId) });
}));

// GET /calls/consent-policy?leadId=
router.get('/consent-policy', requirePermission('call:place'), asyncHandler(async (req, res) => {
  const lead = req.query.leadId
    ? get('SELECT * FROM leads WHERE id = ? AND organization_id = ?', [req.query.leadId, req.auth.organizationId])
    : null;
  const settings = orgSettings(req.auth.organizationId);
  const { countryFromE164 } = await import('../lib/phone.js');
  const policy = telephony.resolveConsentPolicy(settings, {
    country: lead?.country || (req.query.number ? countryFromE164(req.query.number) : null),
    region: lead?.location,
  });
  res.json({
    policy,
    consentOnFile: lead?.consent_recording === 'granted',
    doNotCall: Boolean(lead?.do_not_call),
    recordingRetentionDays: settings.recording?.retentionDays ?? null,
  });
}));

// POST /calls  -- click-to-call
router.post('/', requirePermission('call:place'), asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    leadId: { type: 'string', maxLength: 40 },
    dealId: { type: 'string', maxLength: 40 },
    toNumber: { type: 'string', maxLength: 40 },
    recordingRequested: { type: 'boolean', default: true },
    // Place the call on the agent's own handset instead of through the telephony
    // provider. The CRM record is created either way; see provider.device.js for
    // what this costs (no recording, so no transcript and no AI analysis).
    viaDevice: { type: 'boolean', default: false },
  }, { partial: true });
  if (!body.leadId && !body.toNumber) throw badRequest('Provide a leadId or a toNumber');

  if (body.leadId) {
    const lead = get('SELECT owner_id FROM leads WHERE id = ? AND organization_id = ?', [body.leadId, req.auth.organizationId]);
    if (!lead) throw notFound('Lead');
    assertRecordAccess(req, lead.owner_id);
  }

  const agent = get('SELECT id, name, phone FROM users WHERE id = ?', [req.auth.userId]);
  const result = await telephony.placeCall({
    organizationId: req.auth.organizationId,
    agent,
    leadId: body.leadId || null,
    dealId: body.dealId || null,
    toNumber: body.toNumber || null,
    recordingRequested: body.recordingRequested !== false,
    viaDevice: body.viaDevice === true,
  });

  res.status(201).json({
    call: result.call,
    consent: result.consent,
    // Present only for a device call: the number the handset should dial.
    dialNumber: result.dialNumber,
    lead: result.lead ? crm.leadView(result.lead) : null,
    deal: result.deal ? crm.dealView(result.deal) : null,
    // Everything the in-call panel needs, so the agent never leaves the screen.
    context: result.lead ? callContext(req.auth.organizationId, result.lead.id) : null,
  });
}));

/** Compact CRM context for the live call screen. */
function callContext(organizationId, leadId) {
  return {
    openTasks: all(
      `SELECT id, title, type, priority, due_at FROM tasks WHERE lead_id = ? AND status IN ('open','in_progress')
       ORDER BY due_at ASC LIMIT 5`,
      [leadId],
    ),
    lastCall: get(
      `SELECT c.id, c.started_at, c.duration_seconds, c.outcome, a.summary, a.sentiment,
              a.objections, a.next_steps, a.commitments
       FROM calls c LEFT JOIN call_analyses a ON a.call_id = c.id
       WHERE c.lead_id = ? AND c.status = 'completed' ORDER BY c.started_at DESC LIMIT 1`,
      [leadId],
    ),
    notes: all('SELECT body, created_at FROM notes WHERE lead_id = ? ORDER BY pinned DESC, created_at DESC LIMIT 3', [leadId]),
    recentActivity: all(
      'SELECT type, title, occurred_at FROM activities WHERE lead_id = ? ORDER BY occurred_at DESC LIMIT 6',
      [leadId],
    ),
  };
}

// GET /calls/:id
router.get('/:callId', requirePermission('call:read'), asyncHandler(async (req, res) => {
  const call = get(
    `SELECT c.*, u.name AS agent_name, l.first_name, l.last_name, l.company_name, l.job_title, l.email
     FROM calls c LEFT JOIN users u ON u.id = c.agent_id LEFT JOIN leads l ON l.id = c.lead_id
     WHERE c.id = ? AND c.organization_id = ?`,
    [req.params.callId, req.auth.organizationId],
  );
  if (!call) throw notFound('Call');
  assertRecordAccess(req, call.agent_id);

  res.json({
    call: {
      ...telephony.toView(call),
      agentName: call.agent_name,
      contactName: call.first_name ? `${call.first_name} ${call.last_name || ''}`.trim() : null,
      companyName: call.company_name,
      jobTitle: call.job_title,
      displayNumber: formatDisplay(call.direction === 'inbound' ? call.from_number : call.to_number),
      tags: parseJson(call.tags, []),
      consentMethod: call.consent_method,
      recordingRetained: Boolean(call.recording_object_key),
      recordingDeletedAt: call.recording_deleted_at,
    },
    events: telephony.callEvents(req.auth.organizationId, call.id).map((event) => ({
      id: event.id, type: event.type, payload: parseJson(event.payload, {}), at: event.created_at,
    })),
    context: call.lead_id ? callContext(req.auth.organizationId, call.lead_id) : null,
  });
}));

// --------------------------------------------------------- in-call controls ---
const control = (handler) => asyncHandler(async (req, res) => {
  const call = get('SELECT agent_id FROM calls WHERE id = ? AND organization_id = ?', [req.params.callId, req.auth.organizationId]);
  if (!call) throw notFound('Call');
  assertRecordAccess(req, call.agent_id);
  res.json(await handler(req));
});

router.post('/:callId/answer', requirePermission('call:place'), control(async (req) => ({
  call: await telephony.answerCall({ organizationId: req.auth.organizationId, callId: req.params.callId }),
})));

router.post('/:callId/hold', requirePermission('call:place'), control(async (req) => {
  const body = validate(req.body || {}, { onHold: { type: 'boolean', default: true } }, { partial: true });
  return { call: await telephony.setHold({ organizationId: req.auth.organizationId, callId: req.params.callId, onHold: body.onHold !== false }) };
}));

router.post('/:callId/mute', requirePermission('call:place'), control(async (req) => {
  const body = validate(req.body || {}, { muted: { type: 'boolean', default: true } }, { partial: true });
  return { call: await telephony.setMute({ organizationId: req.auth.organizationId, callId: req.params.callId, muted: body.muted !== false }) };
}));

router.post('/:callId/transfer', requirePermission('call:place'), control(async (req) => {
  const body = validate(req.body, { destination: { type: 'string', required: true, maxLength: 60 } });
  return {
    call: await telephony.transferCall({
      organizationId: req.auth.organizationId, callId: req.params.callId,
      destination: body.destination, actorId: req.auth.userId,
    }),
  };
}));

router.post('/:callId/dtmf', requirePermission('call:place'), control(async (req) => {
  const body = validate(req.body, { digits: { type: 'string', required: true, maxLength: 20 } });
  return telephony.sendDigits({ organizationId: req.auth.organizationId, callId: req.params.callId, digits: body.digits });
}));

router.post('/:callId/consent', requirePermission('call:place'), control(async (req) => {
  const body = validate(req.body, {
    granted: { type: 'boolean', required: true },
    method: { type: 'string', enum: ['verbal', 'announcement', 'written', 'policy'], default: 'verbal' },
  });
  return {
    call: telephony.recordConsent({
      organizationId: req.auth.organizationId, callId: req.params.callId,
      granted: body.granted, method: body.method, actorId: req.auth.userId,
    }),
  };
}));

// POST /calls/:id/end
router.post('/:callId/end', requirePermission('call:place'), control(async (req) => {
  const body = validate(req.body || {}, {
    outcome: { type: 'string', enum: CALL_OUTCOMES },
    notes: { type: 'string', maxLength: 5000 },
    status: { type: 'string', enum: ['completed', 'missed', 'voicemail', 'failed', 'no_answer'], default: 'completed' },
  }, { partial: true });
  return telephony.endCall({
    organizationId: req.auth.organizationId,
    callId: req.params.callId,
    outcome: body.outcome || null,
    notes: body.notes || null,
    status: body.status || 'completed',
    actorId: req.auth.userId,
  });
}));

// PATCH /calls/:id  -- notes, tags and disposition after the fact
router.patch('/:callId', requirePermission('call:read'), control(async (req) => {
  const body = validate(req.body, {
    notes: { type: 'string', maxLength: 5000 },
    outcome: { type: 'string', enum: CALL_OUTCOMES },
    dispositionNote: { type: 'string', maxLength: 500 },
    tags: { type: 'array', of: 'string', maxItems: 15 },
  }, { partial: true });
  const columns = {
    notes: body.notes,
    outcome: body.outcome,
    disposition_note: body.dispositionNote,
    tags: body.tags ? JSON.stringify(body.tags) : undefined,
  };
  const keys = Object.keys(columns).filter((k) => columns[k] !== undefined);
  if (keys.length) {
    run(`UPDATE calls SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND organization_id = ?`,
      [...keys.map((k) => columns[k]), nowIso(), req.params.callId, req.auth.organizationId]);
  }
  const updated = get('SELECT * FROM calls WHERE id = ?', [req.params.callId]);
  return { call: telephony.toView(updated) };
}));

// POST /calls/inbound  -- simulate or receive an inbound call (also used by tests)
router.post('/inbound', requirePermission('call:place'), asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    fromNumber: { type: 'string', required: true, maxLength: 40 },
    toNumber: { type: 'string', maxLength: 40 },
    assignToMe: { type: 'boolean', default: true },
  });
  const result = await telephony.receiveCall({
    organizationId: req.auth.organizationId,
    fromNumber: body.fromNumber,
    toNumber: body.toNumber || config.telephony.callerId,
    agentId: body.assignToMe === false ? null : req.auth.userId,
  });
  res.status(201).json({
    call: result.call,
    lead: result.lead ? crm.leadView(result.lead) : null,
    consent: result.consent,
    context: result.lead ? callContext(req.auth.organizationId, result.lead.id) : null,
  });
}));

// GET /calls/:id/recording  -- streams through the API so access is always checked
router.get('/:callId/recording', requirePermission('call:recording:listen'), asyncHandler(async (req, res) => {
  const call = get('SELECT * FROM calls WHERE id = ? AND organization_id = ?', [req.params.callId, req.auth.organizationId]);
  if (!call) throw notFound('Call');
  assertRecordAccess(req, call.agent_id);
  if (!call.recording_object_key) throw notFound('Recording');
  if (call.recording_consent === 'denied') throw forbidden('Recording consent was denied for this call');

  const meta = await headObject(call.recording_object_key);
  const buffer = await getObject(call.recording_object_key);

  audit.recordFromRequest(req, {
    action: 'call.recording.access', entityType: 'call', entityId: call.id,
    after: { bytes: buffer.length }, source: 'ui',
  });

  res.setHeader('Content-Type', meta?.contentType || 'application/octet-stream');
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Content-Disposition', `inline; filename="call-${call.id}.audio"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
}));

// DELETE /calls/:id/recording  -- honour a deletion request
router.delete('/:callId/recording', requirePermission('call:recording:delete'), asyncHandler(async (req, res) => {
  const call = get('SELECT * FROM calls WHERE id = ? AND organization_id = ?', [req.params.callId, req.auth.organizationId]);
  if (!call) throw notFound('Call');
  if (!call.recording_object_key) throw notFound('Recording');
  const { deleteObject } = await import('../services/storage/index.js');
  await deleteObject(call.recording_object_key);
  run('UPDATE calls SET recording_object_key = NULL, recording_deleted_at = ?, updated_at = ? WHERE id = ?',
    [nowIso(), nowIso(), call.id]);
  audit.recordFromRequest(req, {
    action: 'call.recording.delete', entityType: 'call', entityId: call.id,
    before: { recording_object_key: '[present]' }, after: { recording_object_key: null }, source: 'ui',
  });
  res.json({ ok: true, deletedAt: nowIso() });
}));

// GET /calls/:id/masked-number  -- privacy-preserving display for non-owners
router.get('/:callId/masked-number', requirePermission('call:read'), asyncHandler(async (req, res) => {
  const call = get('SELECT to_number, from_number, direction FROM calls WHERE id = ? AND organization_id = ?',
    [req.params.callId, req.auth.organizationId]);
  if (!call) throw notFound('Call');
  const number = call.direction === 'inbound' ? call.from_number : call.to_number;
  res.json({ masked: maskNumber(number) });
}));

export default router;
