import { Router } from 'express';
import { all, get, insert, run } from '../db/index.js';
import { id } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { validate } from '../lib/validate.js';
import { notFound, badRequest } from '../lib/errors.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requirePermission, assertRecordAccess } from '../middleware/auth.js';
import * as activityService from '../services/activity.js';
import { indexRecord, removeFromIndex } from '../services/search/index.js';
import { noteView } from '../lib/views.js';

const router = Router();


// POST /notes
router.post('/', requirePermission('note:write'), asyncHandler(async (req, res) => {
  const data = validate(req.body, {
    body: { type: 'string', required: true, maxLength: 20000 },
    leadId: { type: 'string', maxLength: 40 },
    dealId: { type: 'string', maxLength: 40 },
    callId: { type: 'string', maxLength: 40 },
    pinned: { type: 'boolean', default: false },
  });
  if (data.leadId) {
    const lead = get('SELECT owner_id FROM leads WHERE id = ? AND organization_id = ?', [data.leadId, req.auth.organizationId]);
    if (!lead) throw notFound('Lead');
    assertRecordAccess(req, lead.owner_id);
  }

  const row = {
    id: id('note'),
    organization_id: req.auth.organizationId,
    lead_id: data.leadId || null,
    deal_id: data.dealId || null,
    call_id: data.callId || null,
    author_id: req.auth.userId,
    body: data.body,
    pinned: data.pinned ? 1 : 0,
    source: 'user',
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('notes', row);

  indexRecord({
    organizationId: req.auth.organizationId, entityType: 'note', entityId: row.id,
    ownerId: req.auth.userId, leadId: row.lead_id, occurredAt: row.created_at,
    title: 'Note', body: row.body,
  });
  activityService.log({
    organizationId: req.auth.organizationId, leadId: row.lead_id, dealId: row.deal_id,
    actorId: req.auth.userId, type: 'note', refId: row.id,
    title: 'Note added', body: row.body.slice(0, 300),
  });
  res.status(201).json({ note: noteView({ ...row, author_name: req.auth.name }) });
}));

// GET /notes?leadId=
router.get('/', requirePermission('lead:read'), asyncHandler(async (req, res) => {
  // 400, not 404. This threw notFound, which told the client the resource was
  // gone -- and produced the message "leadId or dealId not found", as though a
  // record by that name had been looked up. /messages, the same check on the
  // same kind of endpoint, answers 400.
  if (!req.query.leadId && !req.query.dealId) throw badRequest('leadId or dealId is required');
  const rows = all(
    `SELECT n.*, u.name AS author_name FROM notes n LEFT JOIN users u ON u.id = n.author_id
     WHERE n.organization_id = ? AND ${req.query.leadId ? 'n.lead_id = ?' : 'n.deal_id = ?'}
     ORDER BY n.pinned DESC, n.created_at DESC LIMIT 100`,
    [req.auth.organizationId, req.query.leadId || req.query.dealId],
  );
  res.json({ notes: rows.map(noteView) });
}));

// PATCH /notes/:id
router.patch('/:noteId', requirePermission('note:write'), asyncHandler(async (req, res) => {
  const note = get('SELECT * FROM notes WHERE id = ? AND organization_id = ?', [req.params.noteId, req.auth.organizationId]);
  if (!note) throw notFound('Note');
  assertRecordAccess(req, note.author_id);
  const patch = validate(req.body, {
    body: { type: 'string', maxLength: 20000 },
    pinned: { type: 'boolean' },
  }, { partial: true });
  const columns = { body: patch.body, pinned: patch.pinned === undefined ? undefined : patch.pinned ? 1 : 0 };
  const keys = Object.keys(columns).filter((k) => columns[k] !== undefined);
  if (keys.length) {
    run(`UPDATE notes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => columns[k]), nowIso(), note.id]);
  }
  res.json({ note: noteView(get('SELECT * FROM notes WHERE id = ?', [note.id])) });
}));

// DELETE /notes/:id
router.delete('/:noteId', requirePermission('note:write'), asyncHandler(async (req, res) => {
  const note = get('SELECT * FROM notes WHERE id = ? AND organization_id = ?', [req.params.noteId, req.auth.organizationId]);
  if (!note) throw notFound('Note');
  assertRecordAccess(req, note.author_id);
  run('DELETE FROM notes WHERE id = ?', [note.id]);
  removeFromIndex('note', note.id);
  res.json({ ok: true });
}));

export default router;
