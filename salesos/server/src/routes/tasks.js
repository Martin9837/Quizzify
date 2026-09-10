import { Router } from 'express';
import { all, get, run, insert } from '../db/index.js';
import { id } from '../lib/ids.js';
import { nowIso, startOfDay, endOfDay } from '../lib/time.js';
import { validate, parsePagination } from '../lib/validate.js';
import { TASK_TYPES, TASK_PRIORITIES, TASK_STATUSES } from '../lib/constants.js';
import { notFound } from '../lib/errors.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requirePermission, ownerScopeClause, assertRecordAccess } from '../middleware/auth.js';
import * as automation from '../services/automation/index.js';
import { taskView } from '../lib/views.js';
import * as activityService from '../services/activity.js';
import * as audit from '../services/audit.js';
import * as webhooks from '../services/webhooks.js';
import { indexRecord } from '../services/search/index.js';

const router = Router();


// GET /tasks
router.get('/', requirePermission('task:write'), asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 60, maxLimit: 200 });
  const scope = ownerScopeClause(req, 't.assignee_id', { includeUnassigned: true });
  const params = [req.auth.organizationId, ...scope.params];
  const filters = [];
  if (req.query.status) {
    filters.push('t.status = ?');
    params.push(req.query.status);
  } else {
    filters.push(`t.status IN ('open','in_progress')`);
  }
  if (req.query.assigneeId) {
    assertRecordAccess(req, req.query.assigneeId);
    filters.push('t.assignee_id = ?');
    params.push(req.query.assigneeId);
  }
  if (req.query.leadId) {
    filters.push('t.lead_id = ?');
    params.push(req.query.leadId);
  }
  if (req.query.type) {
    filters.push('t.type = ?');
    params.push(req.query.type);
  }
  if (req.query.source) {
    filters.push('t.source = ?');
    params.push(req.query.source);
  }
  if (req.query.dueBefore) {
    filters.push('t.due_at <= ?');
    params.push(req.query.dueBefore);
  }
  if (req.query.overdue === 'true') {
    filters.push('t.due_at < ?');
    params.push(nowIso());
  }
  if (req.query.today === 'true') {
    filters.push('t.due_at BETWEEN ? AND ?');
    params.push(startOfDay(), endOfDay());
  }

  const where = `WHERE t.organization_id = ?${scope.sql}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`;
  const total = get(`SELECT COUNT(*) AS n FROM tasks t ${where}`, params)?.n || 0;
  const rows = all(
    `SELECT t.*, u.name AS assignee_name, l.first_name, l.last_name, l.company_name
     FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN leads l ON l.id = t.lead_id
     ${where} ORDER BY
       CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       t.due_at ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  res.json({
    tasks: rows.map(taskView),
    total,
    limit,
    offset,
    counts: {
      overdue: get(`SELECT COUNT(*) AS n FROM tasks t ${where} AND t.due_at < ?`, [...params, nowIso()])?.n || 0,
      today: get(`SELECT COUNT(*) AS n FROM tasks t ${where} AND t.due_at BETWEEN ? AND ?`, [...params, startOfDay(), endOfDay()])?.n || 0,
    },
    options: { types: TASK_TYPES, priorities: TASK_PRIORITIES, statuses: TASK_STATUSES },
  });
}));

// POST /tasks
router.post('/', requirePermission('task:write'), asyncHandler(async (req, res) => {
  const data = validate(req.body, {
    title: { type: 'string', required: true, maxLength: 240 },
    description: { type: 'string', maxLength: 4000 },
    type: { type: 'string', enum: TASK_TYPES, default: 'follow_up' },
    priority: { type: 'string', enum: TASK_PRIORITIES, default: 'medium' },
    dueAt: { type: 'date' },
    leadId: { type: 'string', maxLength: 40 },
    dealId: { type: 'string', maxLength: 40 },
    callId: { type: 'string', maxLength: 40 },
    assigneeId: { type: 'string', maxLength: 40 },
    reminderMinutesBefore: { type: 'number', min: 0, max: 10080, integer: true, default: 30 },
  });
  const task = automation.createTask({
    organizationId: req.auth.organizationId,
    ...data,
    assigneeId: data.assigneeId || req.auth.userId,
    createdBy: req.auth.userId,
    source: 'user',
  });
  res.status(201).json({ task: taskView(task) });
}));

// PATCH /tasks/:id
router.patch('/:taskId', requirePermission('task:write'), asyncHandler(async (req, res) => {
  const before = get('SELECT * FROM tasks WHERE id = ? AND organization_id = ?', [req.params.taskId, req.auth.organizationId]);
  if (!before) throw notFound('Task');
  assertRecordAccess(req, before.assignee_id);

  const patch = validate(req.body, {
    title: { type: 'string', maxLength: 240 },
    description: { type: 'string', maxLength: 4000 },
    type: { type: 'string', enum: TASK_TYPES },
    priority: { type: 'string', enum: TASK_PRIORITIES },
    status: { type: 'string', enum: TASK_STATUSES },
    dueAt: { type: 'date' },
    assigneeId: { type: 'string', maxLength: 40 },
  }, { partial: true });

  const columns = {
    title: patch.title,
    description: patch.description,
    type: patch.type,
    priority: patch.priority,
    status: patch.status,
    due_at: patch.dueAt,
    assignee_id: patch.assigneeId,
    completed_at: patch.status === 'done' ? nowIso() : patch.status ? null : undefined,
    // Moving the due date re-arms the reminder.
    reminder_sent_at: patch.dueAt ? null : undefined,
  };
  const keys = Object.keys(columns).filter((k) => columns[k] !== undefined);
  if (keys.length) {
    run(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => columns[k]), nowIso(), before.id]);
  }
  const after = get('SELECT * FROM tasks WHERE id = ?', [before.id]);

  if (patch.status === 'done' && before.status !== 'done') {
    activityService.log({
      organizationId: req.auth.organizationId,
      leadId: after.lead_id,
      dealId: after.deal_id,
      actorId: req.auth.userId,
      type: 'task',
      refId: after.id,
      title: `Task completed: ${after.title}`,
      metadata: { type: after.type, source: after.source },
    });
    webhooks.dispatch(req.auth.organizationId, 'task.completed', { taskId: after.id, title: after.title });
  }
  audit.recordFromRequest(req, { action: 'task.update', entityType: 'task', entityId: after.id, before, after });
  indexRecord({
    organizationId: req.auth.organizationId, entityType: 'task', entityId: after.id,
    ownerId: after.assignee_id, leadId: after.lead_id, occurredAt: after.due_at || after.created_at,
    title: after.title, body: [after.description, after.ai_reason].filter(Boolean).join(' '),
  });
  res.json({ task: taskView(after) });
}));

// POST /tasks/:id/complete  -- one-click from the dashboard
router.post('/:taskId/complete', requirePermission('task:write'), asyncHandler(async (req, res) => {
  const task = get('SELECT * FROM tasks WHERE id = ? AND organization_id = ?', [req.params.taskId, req.auth.organizationId]);
  if (!task) throw notFound('Task');
  assertRecordAccess(req, task.assignee_id);
  run(`UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?`, [nowIso(), nowIso(), task.id]);
  activityService.log({
    organizationId: req.auth.organizationId, leadId: task.lead_id, dealId: task.deal_id,
    actorId: req.auth.userId, type: 'task', refId: task.id, title: `Task completed: ${task.title}`,
  });
  webhooks.dispatch(req.auth.organizationId, 'task.completed', { taskId: task.id, title: task.title });
  res.json({ task: taskView(get('SELECT * FROM tasks WHERE id = ?', [task.id])) });
}));

// DELETE /tasks/:id
router.delete('/:taskId', requirePermission('task:write'), asyncHandler(async (req, res) => {
  const task = get('SELECT * FROM tasks WHERE id = ? AND organization_id = ?', [req.params.taskId, req.auth.organizationId]);
  if (!task) throw notFound('Task');
  assertRecordAccess(req, task.assignee_id);
  run(`UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?`, [nowIso(), task.id]);
  res.json({ ok: true });
}));

export default router;
