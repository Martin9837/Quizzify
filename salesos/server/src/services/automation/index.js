import { all, get, insert, run, parseJson } from '../../db/index.js';
import { id } from '../../lib/ids.js';
import { nowIso, addMinutes, addDays, nextBusinessSlot, startOfDay, endOfDay, toIso } from '../../lib/time.js';
import logger from '../../lib/logger.js';
import * as notifications from '../notifications/index.js';
import * as activity from '../activity.js';
import * as audit from '../audit.js';
import * as webhooks from '../webhooks.js';
import { orgSettings } from '../org.js';
import { indexRecord, removeFromIndex } from '../search/index.js';
import { deleteObject } from '../storage/index.js';

/**
 * Automation layer: lead assignment, AI-proposed follow-ups, reminders, and the
 * retention sweeps that keep an organisation inside its own data policy.
 */

// -------------------------------------------------------- lead assignment ----
const OPERATORS = {
  equals: (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase(),
  not_equals: (a, b) => String(a ?? '').toLowerCase() !== String(b ?? '').toLowerCase(),
  contains: (a, b) => String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
  in: (a, b) => (Array.isArray(b) ? b : String(b).split(',')).map((v) => String(v).trim().toLowerCase()).includes(String(a ?? '').toLowerCase()),
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  exists: (a) => a !== null && a !== undefined && a !== '',
};

function matches(rule, lead) {
  const conditions = parseJson(rule.conditions, []);
  if (!conditions.length) return true;
  return conditions.every((condition) => {
    const operator = OPERATORS[condition.op] || OPERATORS.equals;
    return operator(lead[condition.field], condition.value);
  });
}

/**
 * Resolve the owner for a new lead.
 *
 * Rules are evaluated in priority order; the first match wins. Round-robin keeps
 * a per-rule cursor so distribution stays even across restarts, and
 * `least_loaded` counts open leads so a rep who is drowning stops receiving new
 * work automatically.
 */
export function assignLead({ organizationId, lead }) {
  const rules = all(
    'SELECT * FROM assignment_rules WHERE organization_id = ? AND enabled = 1 ORDER BY priority ASC, created_at ASC',
    [organizationId],
  );

  for (const rule of rules) {
    if (!matches(rule, lead)) continue;
    const owner = resolveOwner(organizationId, rule);
    if (!owner) continue;
    logger.debug('assignment rule matched', { ruleId: rule.id, leadId: lead.id, owner });
    return { ownerId: owner, ruleId: rule.id, ruleName: rule.name, strategy: rule.strategy };
  }

  // No rule matched: fall back to the least loaded active member, agents first.
  //
  // This used to require role = 'agent', which is nobody in a new
  // organisation -- the first account is an administrator. So every lead the
  // first user created came back with ownerId null, appeared in /leads, and
  // was missing from the dashboard they had just been looking at, because that
  // filters on owner_id = me. The CASE keeps a staffed organisation behaving
  // exactly as before: an agent is always preferred over a manager or an
  // admin, and only considered if none is available.
  const fallback = get(
    `SELECT u.id FROM users u
     WHERE u.organization_id = ? AND u.status = 'active'
     ORDER BY CASE u.role WHEN 'agent' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
              (SELECT COUNT(*) FROM leads l WHERE l.owner_id = u.id AND l.status IN ('new','contacted')) ASC,
              u.created_at ASC LIMIT 1`,
    [organizationId],
  );
  return fallback ? { ownerId: fallback.id, ruleId: null, ruleName: 'Default (least loaded member)', strategy: 'least_loaded' } : null;
}

function resolveOwner(organizationId, rule) {
  if (rule.strategy === 'specific_user') return rule.target_user_id || null;

  const pool = rule.target_team_id
    ? all(`SELECT id FROM users WHERE organization_id = ? AND team_id = ? AND status = 'active' AND role IN ('agent','manager') ORDER BY created_at ASC`,
      [organizationId, rule.target_team_id])
    : all(`SELECT id FROM users WHERE organization_id = ? AND role = 'agent' AND status = 'active' ORDER BY created_at ASC`,
      [organizationId]);
  if (!pool.length) return null;

  if (rule.strategy === 'round_robin') {
    const index = rule.cursor % pool.length;
    run('UPDATE assignment_rules SET cursor = ?, updated_at = ? WHERE id = ?', [rule.cursor + 1, nowIso(), rule.id]);
    return pool[index].id;
  }

  // team_load / least_loaded
  const counts = pool.map((user) => ({
    id: user.id,
    open: get(`SELECT COUNT(*) AS n FROM leads WHERE owner_id = ? AND status IN ('new','contacted','qualified')`, [user.id])?.n || 0,
  }));
  counts.sort((a, b) => a.open - b.open);
  return counts[0]?.id || null;
}

// ---------------------------------------------------- follow-up automation ---
/**
 * Turn analysis action items into concrete follow-up recommendations.
 *
 * Nothing is created here unless the organisation has opted into automatic task
 * creation: by default these are returned as proposals for the agent to accept,
 * which is the difference between an assistant and an unwanted robot.
 */
export function proposeFollowUps({ organizationId, call, analysis, lead, deal }) {
  const settings = orgSettings(organizationId);
  const autoCreate = settings.crmApproval?.autoCreateTasks === true;
  const actionItems = analysis.action_items || [];
  const proposals = [];

  for (const item of actionItems) {
    if (item.owner === 'customer') continue;
    const dueAt = toIso(item.due_date) || nextBusinessSlot(2);
    proposals.push({
      title: item.text,
      type: item.type || 'follow_up',
      priority: item.priority || 'medium',
      dueAt,
      reason: `From the ${new Date(call.started_at || nowIso()).toLocaleDateString()} call: ${analysis.summary?.slice(0, 160) || 'follow-up agreed on the call'}`,
      leadId: call.lead_id,
      dealId: call.deal_id,
      callId: call.id,
      assigneeId: call.agent_id,
    });
  }

  // A conversation with no explicit action item still needs a next touch.
  if (!proposals.length && analysis.extraction?.follow_up_date) {
    proposals.push({
      title: `Follow up with ${lead ? `${lead.first_name} ${lead.last_name || ''}`.trim() : 'the contact'}`,
      type: 'follow_up',
      priority: analysis.extraction.lead_temperature === 'hot' ? 'high' : 'medium',
      dueAt: toIso(analysis.extraction.follow_up_date) || nextBusinessSlot(3),
      reason: analysis.summary?.slice(0, 160) || 'Keep the conversation moving',
      leadId: call.lead_id,
      dealId: call.deal_id,
      callId: call.id,
      assigneeId: call.agent_id,
    });
  }

  if (!autoCreate) return { proposals, created: [] };

  const created = proposals.map((proposal) => createTask({
    organizationId, ...proposal, source: 'ai', actorId: null,
  }));
  return { proposals, created };
}

export function createTask({
  organizationId, title, description = null, type = 'follow_up', priority = 'medium',
  dueAt = null, leadId = null, dealId = null, callId = null, assigneeId = null,
  createdBy = null, source = 'user', reason = null, reminderMinutesBefore = 30,
}) {
  const due = dueAt || nextBusinessSlot(1);
  const row = {
    id: id('tsk'),
    organization_id: organizationId,
    lead_id: leadId,
    deal_id: dealId,
    call_id: callId,
    assignee_id: assigneeId,
    created_by: createdBy,
    title,
    description,
    type,
    priority,
    status: 'open',
    due_at: due,
    source,
    ai_reason: reason,
    reminder_at: addMinutes(-reminderMinutesBefore, new Date(due)),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('tasks', row);

  indexRecord({
    organizationId, entityType: 'task', entityId: row.id, ownerId: assigneeId, leadId,
    occurredAt: due, title, body: [description, reason].filter(Boolean).join(' '),
  });

  activity.log({
    organizationId, leadId, dealId, actorId: createdBy, actorType: source === 'ai' ? 'ai' : 'user',
    type: 'task', refId: row.id, title: `Task created: ${title}`,
    metadata: { type, priority, dueAt: due, source },
  });

  if (assigneeId) {
    notifications.notify({
      organizationId,
      userId: assigneeId,
      type: source === 'ai' ? 'ai_recommendation' : 'task',
      title: source === 'ai' ? `AI created a follow-up: ${title}` : `New task: ${title}`,
      body: reason || description,
      entityType: 'task',
      entityId: row.id,
      link: leadId ? `/leads/${leadId}` : '/tasks',
      priority: priority === 'urgent' ? 'high' : 'normal',
    });
  }

  webhooks.dispatch(organizationId, 'task.created', { taskId: row.id, title, dueAt: due, source });
  return row;
}

// ------------------------------------------------------------- scheduler -----
/**
 * Periodic sweep. Deliberately idempotent: every action is guarded by a
 * "already handled" column so running twice never double-notifies.
 */
export function runScheduler() {
  const results = { taskReminders: 0, meetingReminders: 0, overdueAlerts: 0, staleLeadAlerts: 0, retentionDeletions: 0 };
  const organizations = all('SELECT id FROM organizations');

  for (const org of organizations) {
    results.taskReminders += sendTaskReminders(org.id);
    results.meetingReminders += sendMeetingReminders(org.id);
    results.overdueAlerts += sendOverdueDigest(org.id);
    results.staleLeadAlerts += alertOnStaleHotLeads(org.id);
  }
  results.retentionDeletions = enforceRetention();
  logger.debug('scheduler pass complete', results);
  return results;
}

function sendTaskReminders(organizationId) {
  const due = all(
    `SELECT t.*, l.first_name, l.last_name, l.company_name FROM tasks t
     LEFT JOIN leads l ON l.id = t.lead_id
     WHERE t.organization_id = ? AND t.status = 'open' AND t.assignee_id IS NOT NULL
       AND t.reminder_at IS NOT NULL AND t.reminder_at <= ? AND t.reminder_sent_at IS NULL
     LIMIT 200`,
    [organizationId, nowIso()],
  );
  for (const task of due) {
    const who = task.first_name ? ` - ${task.first_name} ${task.last_name || ''} at ${task.company_name || ''}`.trimEnd() : '';
    notifications.notify({
      organizationId,
      userId: task.assignee_id,
      type: 'task',
      title: `Due soon: ${task.title}`,
      body: `${new Date(task.due_at).toLocaleString()}${who}`,
      entityType: 'task',
      entityId: task.id,
      link: task.lead_id ? `/leads/${task.lead_id}` : '/tasks',
      priority: task.priority === 'urgent' ? 'high' : 'normal',
      channels: orgSettings(organizationId).notifications?.emailReminders ? ['in_app', 'email'] : ['in_app'],
    });
    run('UPDATE tasks SET reminder_sent_at = ? WHERE id = ?', [nowIso(), task.id]);
  }
  return due.length;
}

function sendMeetingReminders(organizationId) {
  const upcoming = all(
    `SELECT * FROM meetings WHERE organization_id = ? AND status = 'scheduled'
       AND reminder_sent_at IS NULL AND starts_at > ?
       AND datetime(starts_at, '-' || reminder_minutes || ' minutes') <= ?
     LIMIT 200`,
    [organizationId, nowIso(), nowIso()],
  );
  for (const meeting of upcoming) {
    if (meeting.organizer_id) {
      notifications.notify({
        organizationId,
        userId: meeting.organizer_id,
        type: 'meeting',
        title: `Starting soon: ${meeting.title}`,
        body: `${new Date(meeting.starts_at).toLocaleString()}${meeting.conference_url ? ` - ${meeting.conference_url}` : ''}`,
        entityType: 'meeting',
        entityId: meeting.id,
        link: meeting.lead_id ? `/leads/${meeting.lead_id}` : '/calendar',
        priority: 'high',
      });
    }
    run('UPDATE meetings SET reminder_sent_at = ? WHERE id = ?', [nowIso(), meeting.id]);
  }
  return upcoming.length;
}

function sendOverdueDigest(organizationId) {
  const settings = orgSettings(organizationId);
  if (settings.notifications?.managerAlerts === false) return 0;
  // One alert per agent per day at most: overdue work is a pattern, not an event.
  const offenders = all(
    `SELECT assignee_id, COUNT(*) AS overdue FROM tasks
     WHERE organization_id = ? AND status = 'open' AND due_at < ? AND assignee_id IS NOT NULL
     GROUP BY assignee_id HAVING overdue >= 5`,
    [organizationId, startOfDay()],
  );
  let sent = 0;
  for (const offender of offenders) {
    const alreadyToday = get(
      `SELECT COUNT(*) AS n FROM notifications WHERE organization_id = ? AND type = 'manager_alert'
         AND entity_id = ? AND created_at >= ?`,
      [organizationId, offender.assignee_id, startOfDay()],
    )?.n;
    if (alreadyToday) continue;
    const user = get('SELECT name FROM users WHERE id = ?', [offender.assignee_id]);
    notifications.notifyManagers({
      organizationId,
      type: 'manager_alert',
      title: `${user?.name || 'An agent'} has ${offender.overdue} overdue tasks`,
      body: 'Follow-up completion is the leading indicator for pipeline slippage.',
      entityType: 'user',
      entityId: offender.assignee_id,
      link: '/team',
    });
    sent += 1;
  }
  return sent;
}

function alertOnStaleHotLeads(organizationId) {
  const stale = all(
    `SELECT l.id, l.first_name, l.last_name, l.company_name, l.owner_id, l.last_contacted_at
     FROM leads l WHERE l.organization_id = ? AND l.temperature = 'hot' AND l.archived_at IS NULL
       AND l.status NOT IN ('customer','lost','unqualified')
       AND (l.last_contacted_at IS NULL OR l.last_contacted_at < ?)
       AND l.owner_id IS NOT NULL
     LIMIT 50`,
    [organizationId, addDays(-7)],
  );
  let sent = 0;
  for (const lead of stale) {
    const alreadySent = get(
      `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = 'ai_recommendation'
         AND entity_id = ? AND created_at >= ?`,
      [lead.owner_id, lead.id, addDays(-3)],
    )?.n;
    if (alreadySent) continue;
    notifications.notify({
      organizationId,
      userId: lead.owner_id,
      type: 'ai_recommendation',
      title: `Hot lead going cold: ${lead.first_name} ${lead.last_name || ''}`.trim(),
      body: `${lead.company_name || 'This contact'} has had no contact for over a week. Hot leads decay fastest in the first ten days.`,
      entityType: 'lead',
      entityId: lead.id,
      link: `/leads/${lead.id}`,
      priority: 'high',
    });
    sent += 1;
  }
  return sent;
}

/**
 * Data retention. Recordings, transcripts, activities and audit entries are
 * removed once past the organisation's configured window. Recording objects are
 * deleted from storage, not just dereferenced.
 */
export function enforceRetention() {
  let deletions = 0;
  for (const org of all('SELECT id FROM organizations')) {
    const settings = orgSettings(org.id);
    const retention = settings.dataRetention || {};

    if (retention.recordingDays) {
      const cutoff = addDays(-retention.recordingDays);
      const expired = all(
        `SELECT id, recording_object_key FROM calls
         WHERE organization_id = ? AND recording_object_key IS NOT NULL
           AND recording_deleted_at IS NULL AND created_at < ? LIMIT 200`,
        [org.id, cutoff],
      );
      for (const call of expired) {
        deleteObject(call.recording_object_key).catch((error) => logger.warn('recording delete failed', { callId: call.id, error: error.message }));
        run('UPDATE calls SET recording_object_key = NULL, recording_deleted_at = ? WHERE id = ?', [nowIso(), call.id]);
        audit.record({
          organizationId: org.id, actorType: 'system', action: 'retention.recording.delete',
          entityType: 'call', entityId: call.id, source: 'automation',
        });
        deletions += 1;
      }
    }

    if (retention.transcriptDays) {
      const cutoff = addDays(-retention.transcriptDays);
      const expired = all('SELECT id FROM transcripts WHERE organization_id = ? AND created_at < ? LIMIT 200', [org.id, cutoff]);
      for (const transcript of expired) {
        run('DELETE FROM transcripts WHERE id = ?', [transcript.id]);
        removeFromIndex('transcript', transcript.id);
        deletions += 1;
      }
    }

    if (retention.activityDays) {
      const result = run('DELETE FROM activities WHERE organization_id = ? AND occurred_at < ?', [org.id, addDays(-retention.activityDays)]);
      deletions += result.changes;
    }
    if (retention.auditLogDays) {
      const result = run('DELETE FROM audit_logs WHERE organization_id = ? AND created_at < ?', [org.id, addDays(-retention.auditLogDays)]);
      deletions += result.changes;
    }
  }
  return deletions;
}

/** Suggest meeting slots from existing calendar load. */
export function suggestMeetingSlots({ organizationId, userId, durationMinutes = 30, daysAhead = 5, count = 5 }) {
  const busy = all(
    `SELECT starts_at, ends_at FROM meetings WHERE organization_id = ? AND organizer_id = ?
       AND status = 'scheduled' AND starts_at BETWEEN ? AND ?`,
    [organizationId, userId, nowIso(), endOfDay(new Date(), daysAhead)],
  ).map((m) => ({ start: new Date(m.starts_at).getTime(), end: new Date(m.ends_at).getTime() }));

  const slots = [];
  // Working hours 9-17 UTC, on the half hour, skipping weekends and clashes.
  for (let day = 1; day <= daysAhead && slots.length < count; day += 1) {
    const base = new Date();
    base.setUTCDate(base.getUTCDate() + day);
    if (base.getUTCDay() === 0 || base.getUTCDay() === 6) continue;
    for (const hour of [9, 10, 11, 13, 14, 15, 16]) {
      if (slots.length >= count) break;
      const start = new Date(base);
      start.setUTCHours(hour, 0, 0, 0);
      const end = new Date(start.getTime() + durationMinutes * 60000);
      const clashes = busy.some((b) => start.getTime() < b.end && end.getTime() > b.start);
      if (clashes) continue;
      slots.push({
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        rationale: hour < 12 ? 'Morning slot - highest answer rates' : 'Afternoon slot',
      });
    }
  }
  return slots;
}

export default { assignLead, proposeFollowUps, createTask, runScheduler, enforceRetention, suggestMeetingSlots };
