import { Router } from 'express';
import { all, get, insert, run, parseJson } from '../db/index.js';
import { id } from '../lib/ids.js';
import { nowIso, startOfDay, endOfDay } from '../lib/time.js';
import { validate, boundedInt } from '../lib/validate.js';
import { notFound, badRequest } from '../lib/errors.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requirePermission, ownerScopeClause, assertRecordAccess } from '../middleware/auth.js';
import * as activityService from '../services/activity.js';
import * as automation from '../services/automation/index.js';
import * as webhooks from '../services/webhooks.js';
import { meetingView } from '../lib/views.js';
import { indexRecord } from '../services/search/index.js';
import { enqueue } from '../services/queue/index.js';
import config from '../config.js';

const router = Router();


// GET /meetings
router.get('/', requirePermission('meeting:write'), asyncHandler(async (req, res) => {
  const scope = ownerScopeClause(req, 'm.organizer_id', { includeUnassigned: true });
  const params = [req.auth.organizationId, ...scope.params];
  const filters = [];
  if (req.query.from) {
    filters.push('m.starts_at >= ?');
    params.push(req.query.from);
  }
  if (req.query.to) {
    filters.push('m.starts_at <= ?');
    params.push(req.query.to);
  }
  if (req.query.leadId) {
    filters.push('m.lead_id = ?');
    params.push(req.query.leadId);
  }
  if (req.query.status) {
    filters.push('m.status = ?');
    params.push(req.query.status);
  }
  const rows = all(
    `SELECT m.*, u.name AS organizer_name, l.first_name, l.last_name, l.company_name
     FROM meetings m LEFT JOIN users u ON u.id = m.organizer_id LEFT JOIN leads l ON l.id = m.lead_id
     WHERE m.organization_id = ?${scope.sql}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}
     ORDER BY m.starts_at ASC LIMIT 300`,
    params,
  );
  res.json({
    meetings: rows.map(meetingView),
    today: rows.filter((r) => r.starts_at >= startOfDay() && r.starts_at <= endOfDay()).length,
  });
}));

// POST /meetings
router.post('/', requirePermission('meeting:write'), asyncHandler(async (req, res) => {
  const data = validate(req.body, {
    title: { type: 'string', required: true, maxLength: 200 },
    description: { type: 'string', maxLength: 4000 },
    type: { type: 'string', enum: ['meeting', 'demo', 'discovery', 'follow_up', 'internal'], default: 'meeting' },
    startsAt: { type: 'date', required: true },
    endsAt: { type: 'date' },
    durationMinutes: { type: 'number', min: 5, max: 480, integer: true, default: 30 },
    timezone: { type: 'string', maxLength: 60, default: 'UTC' },
    location: { type: 'string', maxLength: 200 },
    conferenceUrl: { type: 'string', maxLength: 400 },
    leadId: { type: 'string', maxLength: 40 },
    dealId: { type: 'string', maxLength: 40 },
    attendees: { type: 'array', maxItems: 20 },
    reminderMinutes: { type: 'number', min: 0, max: 10080, integer: true, default: 15 },
    sendInvite: { type: 'boolean', default: true },
    aiSuggested: { type: 'boolean', default: false },
  });

  if (data.leadId) {
    const lead = get('SELECT owner_id, email, first_name, last_name FROM leads WHERE id = ? AND organization_id = ?',
      [data.leadId, req.auth.organizationId]);
    if (!lead) throw notFound('Lead');
    assertRecordAccess(req, lead.owner_id);
    if (!data.attendees?.length && lead.email) {
      data.attendees = [{ email: lead.email, name: `${lead.first_name} ${lead.last_name || ''}`.trim(), role: 'contact' }];
    }
  }

  const endsAt = data.endsAt || new Date(new Date(data.startsAt).getTime() + data.durationMinutes * 60000).toISOString();
  if (new Date(endsAt) <= new Date(data.startsAt)) throw badRequest('The meeting must end after it starts');

  const row = {
    id: id('mtg'),
    organization_id: req.auth.organizationId,
    lead_id: data.leadId || null,
    deal_id: data.dealId || null,
    organizer_id: req.auth.userId,
    title: data.title,
    description: data.description || null,
    type: data.type,
    location: data.location || null,
    conference_url: data.conferenceUrl || `${config.publicUrl}/meet/${id('room')}`,
    starts_at: data.startsAt,
    ends_at: endsAt,
    timezone: data.timezone,
    attendees: JSON.stringify(data.attendees || []),
    status: 'scheduled',
    reminder_minutes: data.reminderMinutes,
    ai_suggested: data.aiSuggested ? 1 : 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('meetings', row);

  indexRecord({
    organizationId: req.auth.organizationId, entityType: 'meeting', entityId: row.id,
    ownerId: req.auth.userId, leadId: row.lead_id, occurredAt: row.starts_at,
    title: row.title, body: [row.description, row.location].filter(Boolean).join(' '),
  });
  activityService.log({
    organizationId: req.auth.organizationId, leadId: row.lead_id, dealId: row.deal_id,
    actorId: req.auth.userId, type: 'meeting', refId: row.id,
    title: `Meeting scheduled: ${row.title}`,
    metadata: { startsAt: row.starts_at, type: row.type, aiSuggested: Boolean(row.ai_suggested) },
    occurredAt: row.created_at,
  });
  webhooks.dispatch(req.auth.organizationId, 'meeting.scheduled', {
    meetingId: row.id, leadId: row.lead_id, startsAt: row.starts_at,
  });

  // Calendar invitations go out through the email pipeline so failures retry.
  if (data.sendInvite && (data.attendees || []).some((a) => a.email)) {
    const invite = {
      id: id('eml'),
      organization_id: req.auth.organizationId,
      lead_id: row.lead_id,
      deal_id: row.deal_id,
      user_id: req.auth.userId,
      direction: 'outbound',
      template: 'meeting_confirmation',
      to_address: data.attendees.find((a) => a.email).email,
      cc: JSON.stringify(data.attendees.slice(1).map((a) => a.email).filter(Boolean)),
      subject: `Invitation: ${row.title}`,
      body: [
        `You are invited to: ${row.title}`,
        '',
        `When: ${new Date(row.starts_at).toUTCString()} (${row.timezone})`,
        row.location ? `Where: ${row.location}` : null,
        row.conference_url ? `Join: ${row.conference_url}` : null,
        '',
        row.description || '',
      ].filter(Boolean).join('\n'),
      body_format: 'text',
      status: 'queued',
      generated_by_ai: 0,
      ai_metadata: JSON.stringify({ meetingId: row.id }),
      edited_by_human: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    insert('emails', invite);
    enqueue('email.send', { emailId: invite.id }, { organizationId: req.auth.organizationId, priority: 4 });
    run('UPDATE meetings SET invite_sent_at = ? WHERE id = ?', [nowIso(), row.id]);
  }

  res.status(201).json({ meeting: meetingView(row) });
}));

// PATCH /meetings/:id
router.patch('/:meetingId', requirePermission('meeting:write'), asyncHandler(async (req, res) => {
  const meeting = get('SELECT * FROM meetings WHERE id = ? AND organization_id = ?', [req.params.meetingId, req.auth.organizationId]);
  if (!meeting) throw notFound('Meeting');
  assertRecordAccess(req, meeting.organizer_id);

  const patch = validate(req.body, {
    title: { type: 'string', maxLength: 200 },
    description: { type: 'string', maxLength: 4000 },
    startsAt: { type: 'date' },
    endsAt: { type: 'date' },
    status: { type: 'string', enum: ['scheduled', 'held', 'cancelled', 'no_show'] },
    location: { type: 'string', maxLength: 200 },
    outcomeNotes: { type: 'string', maxLength: 4000 },
    reminderMinutes: { type: 'number', min: 0, max: 10080, integer: true },
  }, { partial: true });

  const columns = {
    title: patch.title,
    description: patch.description,
    starts_at: patch.startsAt,
    ends_at: patch.endsAt,
    status: patch.status,
    location: patch.location,
    outcome_notes: patch.outcomeNotes,
    reminder_minutes: patch.reminderMinutes,
    reminder_sent_at: patch.startsAt ? null : undefined,
  };
  const keys = Object.keys(columns).filter((k) => columns[k] !== undefined);
  if (keys.length) {
    run(`UPDATE meetings SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => columns[k]), nowIso(), meeting.id]);
  }
  res.json({ meeting: meetingView(get('SELECT * FROM meetings WHERE id = ?', [meeting.id])) });
}));

// GET /meetings/slots  -- AI-suggested times
router.get('/slots/suggest', requirePermission('meeting:write'), asyncHandler(async (req, res) => {
  res.json({
    slots: automation.suggestMeetingSlots({
      organizationId: req.auth.organizationId,
      userId: req.auth.userId,
      durationMinutes: boundedInt(req.query.duration, 30, { min: 5, max: 480 }),
      daysAhead: boundedInt(req.query.days, 5, { min: 1, max: 60 }),
      count: boundedInt(req.query.count, 6, { min: 1, max: 50 }),
    }),
  });
}));

export default router;
