import { all, get, parseJson, inList } from '../../db/index.js';
import { startOfDay, endOfDay, nowIso } from '../../lib/time.js';
import { OPEN_STAGE_KEYS, STAGE_MAP } from '../../lib/constants.js';

/**
 * Sales intelligence. Every function is a plain SQL query over the tenant's own
 * data, scoped by `ownerIds` so an agent's insights only ever cover their book
 * of business. These same functions back the manager dashboard, the insights
 * page, and the AI assistant's tools -- one implementation, one set of rules.
 */

/** Human-scaled age: 6h, 3d, 5w. "untouched for 3768h" tells nobody anything. */
function ageLabel(hours) {
  const value = Math.max(0, Math.round(Number(hours) || 0));
  if (value < 48) return `${value}h`;
  const days = Math.round(value / 24);
  return days < 21 ? `${days}d` : `${Math.round(days / 7)}w`;
}

const ownerClause = (ownerIds, column = 'owner_id') => {
  if (!ownerIds || ownerIds === 'all') return { sql: '', params: [] };
  const list = Array.isArray(ownerIds) ? ownerIds : [ownerIds];
  if (!list.length) return { sql: ' AND 1 = 0', params: [] };
  const { sql, params } = inList(column, list);
  return { sql: ` AND ${sql}`, params };
};

// ------------------------------------------------------ conversion scoring ---
/**
 * Which leads are most likely to convert.
 *
 * Blends the AI lead score with observable behaviour: recent two-way contact,
 * buying signals detected on calls, an open deal with movement, and objections
 * that remain unresolved. Each contributing factor is returned so the agent can
 * see why a lead is ranked where it is.
 */
export function likelyToConvert({ organizationId, ownerIds = 'all', limit = 10 }) {
  const owner = ownerClause(ownerIds, 'l.owner_id');
  const rows = all(
    `SELECT l.*, u.name AS owner_name,
       d.id AS deal_id, d.name AS deal_name, d.stage, d.value AS deal_amount, d.probability, d.expected_close_date,
       (SELECT COUNT(*) FROM calls c WHERE c.lead_id = l.id AND c.outcome = 'connected') AS connected_calls,
       (SELECT COUNT(*) FROM emails e WHERE e.lead_id = l.id AND e.status = 'sent') AS emails_sent,
       (SELECT COUNT(*) FROM meetings m WHERE m.lead_id = l.id AND m.status != 'cancelled') AS meetings,
       (SELECT MAX(c.started_at) FROM calls c WHERE c.lead_id = l.id) AS last_call_at,
       (SELECT COUNT(*) FROM call_analyses a JOIN calls c2 ON c2.id = a.call_id
          WHERE c2.lead_id = l.id AND json_array_length(a.buying_signals) > 1) AS signal_calls,
       (SELECT COUNT(*) FROM call_analyses a JOIN calls c3 ON c3.id = a.call_id
          WHERE c3.lead_id = l.id AND json_array_length(a.objections) > 0) AS objection_calls,
       l.do_not_call
     FROM leads l
     LEFT JOIN users u ON u.id = l.owner_id
     LEFT JOIN deals d ON d.lead_id = l.id AND d.stage NOT IN ('won','lost')
     WHERE l.organization_id = ? AND l.archived_at IS NULL AND l.status NOT IN ('customer','lost','unqualified')${owner.sql}`,
    [organizationId, ...owner.params],
  );

  const scored = rows.map((row) => {
    const factors = [];
    let score = row.score * 0.5;
    factors.push({ label: 'AI lead score', points: Math.round(row.score * 0.5) });

    if (row.temperature === 'hot') {
      score += 15;
      factors.push({ label: 'Marked hot', points: 15 });
    } else if (row.temperature === 'warm') {
      score += 7;
      factors.push({ label: 'Marked warm', points: 7 });
    }
    if (row.signal_calls) {
      const points = Math.min(18, row.signal_calls * 9);
      score += points;
      factors.push({ label: `Buying signals on ${row.signal_calls} call(s)`, points });
    }
    if (row.connected_calls) {
      const points = Math.min(12, row.connected_calls * 4);
      score += points;
      factors.push({ label: `${row.connected_calls} connected call(s)`, points });
    }
    if (row.meetings) {
      score += 10;
      factors.push({ label: `${row.meetings} meeting(s) booked`, points: 10 });
    }
    if (row.stage) {
      const points = Math.round((STAGE_MAP[row.stage]?.probability || 0) * 0.25);
      score += points;
      factors.push({ label: `Deal at ${STAGE_MAP[row.stage]?.label || row.stage}`, points });
    }
    if (row.last_call_at) {
      const days = (Date.now() - new Date(row.last_call_at)) / 86400000;
      if (days <= 7) {
        score += 8;
        factors.push({ label: 'Contacted in the last week', points: 8 });
      } else if (days > 30) {
        score -= 12;
        factors.push({ label: `No contact for ${Math.round(days)} days`, points: -12 });
      }
    }
    if (row.objection_calls > row.signal_calls) {
      score -= 8;
      factors.push({ label: 'Objections outweigh buying signals', points: -8 });
    }

    return {
      leadId: row.id,
      name: `${row.first_name} ${row.last_name || ''}`.trim(),
      company: row.company_name,
      ownerName: row.owner_name,
      temperature: row.temperature,
      doNotCall: Boolean(row.do_not_call),
      dealId: row.deal_id,
      dealName: row.deal_name,
      stage: row.stage,
      value: row.deal_amount || row.deal_value || 0,
      expectedCloseDate: row.expected_close_date,
      likelihood: Math.max(1, Math.min(99, Math.round(score))),
      factors: factors.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)).slice(0, 4),
    };
  });

  return scored.sort((a, b) => b.likelihood - a.likelihood).slice(0, limit);
}

// ---------------------------------------------------------- deals at risk ----
/**
 * Deal risk. A deal is at risk when it stops moving, when the conversation
 * carries unresolved high-severity objections, when the close date is about to
 * pass, or when a competitor is in play without a recent conversation.
 */
export function dealsAtRisk({ organizationId, ownerIds = 'all', limit = 15 }) {
  const owner = ownerClause(ownerIds, 'd.owner_id');
  const rows = all(
    `SELECT d.*, l.first_name, l.last_name, l.company_name, l.temperature, u.name AS owner_name,
       (SELECT MAX(c.started_at) FROM calls c WHERE c.deal_id = d.id OR c.lead_id = d.lead_id) AS last_call_at,
       (SELECT MAX(e.sent_at) FROM emails e WHERE e.deal_id = d.id OR e.lead_id = d.lead_id) AS last_email_at,
       (SELECT COUNT(*) FROM tasks t WHERE t.deal_id = d.id AND t.status = 'open' AND t.due_at < ?) AS overdue_tasks,
       (SELECT a.objections FROM call_analyses a JOIN calls c ON c.id = a.call_id
          WHERE c.lead_id = d.lead_id ORDER BY a.created_at DESC LIMIT 1) AS last_objections,
       (SELECT a.sentiment FROM call_analyses a JOIN calls c ON c.id = a.call_id
          WHERE c.lead_id = d.lead_id ORDER BY a.created_at DESC LIMIT 1) AS last_sentiment
     FROM deals d
     LEFT JOIN leads l ON l.id = d.lead_id
     LEFT JOIN users u ON u.id = d.owner_id
     WHERE d.organization_id = ? AND d.stage NOT IN ('won','lost')${owner.sql}`,
    [nowIso(), organizationId, ...owner.params],
  );

  const assessed = rows.map((row) => {
    const reasons = [];
    let risk = 0;
    const daysSinceContact = row.last_call_at || row.last_email_at
      ? Math.round((Date.now() - new Date(Math.max(
        row.last_call_at ? new Date(row.last_call_at).getTime() : 0,
        row.last_email_at ? new Date(row.last_email_at).getTime() : 0,
      ))) / 86400000)
      : null;

    if (daysSinceContact === null) {
      risk += 30;
      reasons.push('No conversation recorded on this deal');
    } else if (daysSinceContact > 21) {
      risk += 32;
      reasons.push(`No contact for ${daysSinceContact} days`);
    } else if (daysSinceContact > 10) {
      risk += 16;
      reasons.push(`Last contact ${daysSinceContact} days ago`);
    }

    const stalledDays = row.stage_entered_at
      ? Math.round((Date.now() - new Date(row.stage_entered_at)) / 86400000)
      : null;
    if (stalledDays !== null && stalledDays > 30) {
      risk += 20;
      reasons.push(`Stuck in ${STAGE_MAP[row.stage]?.label || row.stage} for ${stalledDays} days`);
    }

    if (row.expected_close_date) {
      const daysToClose = Math.round((new Date(row.expected_close_date) - Date.now()) / 86400000);
      if (daysToClose < 0) {
        risk += 28;
        reasons.push(`Close date passed ${Math.abs(daysToClose)} days ago`);
      } else if (daysToClose < 14 && OPEN_STAGE_KEYS.indexOf(row.stage) < OPEN_STAGE_KEYS.indexOf('proposal')) {
        risk += 18;
        reasons.push(`Closing in ${daysToClose} days but only at ${STAGE_MAP[row.stage]?.label || row.stage}`);
      }
    } else {
      risk += 8;
      reasons.push('No expected close date set');
    }

    const objections = parseJson(row.last_objections, []);
    const unresolved = objections.filter((o) => o.severity === 'high' && !o.handled);
    if (unresolved.length) {
      risk += 22;
      reasons.push(`Unresolved ${unresolved.map((o) => String(o.category).replace('_', ' ')).join(' / ')} objection`);
    }
    if (row.last_sentiment === 'negative') {
      risk += 14;
      reasons.push('Last conversation had negative sentiment');
    }
    const competitors = parseJson(row.competitors, []);
    if (competitors.length) {
      risk += 12;
      reasons.push(`Competitive: ${competitors.join(', ')}`);
    }
    if (row.overdue_tasks) {
      risk += 10;
      reasons.push(`${row.overdue_tasks} overdue task(s)`);
    }
    if (!row.decision_maker) {
      risk += 8;
      reasons.push('Decision maker not identified');
    }
    if (!row.budget) {
      risk += 6;
      reasons.push('Budget not confirmed');
    }

    const score = Math.max(0, Math.min(100, risk));
    return {
      dealId: row.id,
      name: row.name,
      leadId: row.lead_id,
      contact: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
      company: row.company_name,
      ownerName: row.owner_name,
      stage: row.stage,
      value: row.value,
      probability: row.probability,
      expectedCloseDate: row.expected_close_date,
      daysSinceContact,
      riskScore: score,
      health: score >= 60 ? 'at_risk' : score >= 30 ? 'watch' : 'healthy',
      reasons: reasons.slice(0, 4),
      recommendedAction: recommendedAction({ reasons, row, daysSinceContact }),
    };
  });

  return assessed.filter((d) => d.riskScore >= 25).sort((a, b) => b.riskScore - a.riskScore).slice(0, limit);
}

function recommendedAction({ reasons, row, daysSinceContact }) {
  if (reasons.some((r) => r.startsWith('No contact')) || daysSinceContact === null) {
    return `Call ${row.first_name || 'the contact'} today and re-establish the next step`;
  }
  if (reasons.some((r) => r.includes('Unresolved'))) return 'Send a written response to the open objection with evidence';
  if (reasons.some((r) => r.includes('Close date passed'))) return 'Re-forecast the close date with the customer or move the deal out';
  if (reasons.some((r) => r.includes('Decision maker'))) return 'Ask who signs off and get them into the next conversation';
  if (reasons.some((r) => r.includes('Competitive'))) return 'Send a differentiation summary before the customer compares on price alone';
  return 'Confirm the next step in writing with a date';
}

// ------------------------------------------------------------- follow-ups ----
export function needsFollowUp({ organizationId, ownerIds = 'all', days = 14, limit = 20 }) {
  const owner = ownerClause(ownerIds, 'l.owner_id');
  const cutoff = startOfDay(new Date(), -days);
  return all(
    `SELECT l.id AS lead_id, l.first_name, l.last_name, l.company_name, l.temperature, l.status,
            l.last_contacted_at, l.next_follow_up_at, l.owner_id, u.name AS owner_name,
            (SELECT COUNT(*) FROM tasks t WHERE t.lead_id = l.id AND t.status = 'open') AS open_tasks
     FROM leads l LEFT JOIN users u ON u.id = l.owner_id
     WHERE l.organization_id = ? AND l.archived_at IS NULL AND l.do_not_call = 0
       AND l.status NOT IN ('customer','lost','unqualified')
       AND (l.last_contacted_at IS NULL OR l.last_contacted_at < ?)${owner.sql}
     ORDER BY CASE l.temperature WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END,
              COALESCE(l.last_contacted_at, l.created_at) ASC
     LIMIT ?`,
    [organizationId, cutoff, ...owner.params, limit],
  ).map((row) => ({
    leadId: row.lead_id,
    name: `${row.first_name} ${row.last_name || ''}`.trim(),
    company: row.company_name,
    temperature: row.temperature,
    status: row.status,
    ownerName: row.owner_name,
    lastContactedAt: row.last_contacted_at,
    nextFollowUpAt: row.next_follow_up_at,
    openTasks: row.open_tasks,
    daysSinceContact: row.last_contacted_at
      ? Math.round((Date.now() - new Date(row.last_contacted_at)) / 86400000)
      : null,
  }));
}

export function neverContacted({ organizationId, ownerIds = 'all', limit = 20 }) {
  const owner = ownerClause(ownerIds, 'l.owner_id');
  return all(
    `SELECT l.id AS lead_id, l.first_name, l.last_name, l.company_name, l.temperature, l.source,
            l.created_at, l.score, u.name AS owner_name
     FROM leads l LEFT JOIN users u ON u.id = l.owner_id
     WHERE l.organization_id = ? AND l.archived_at IS NULL AND l.last_contacted_at IS NULL
       AND l.do_not_call = 0 AND l.status = 'new'${owner.sql}
     ORDER BY l.score DESC, l.created_at ASC LIMIT ?`,
    [organizationId, ...owner.params, limit],
  ).map((row) => ({
    leadId: row.lead_id,
    name: `${row.first_name} ${row.last_name || ''}`.trim(),
    company: row.company_name,
    source: row.source,
    score: row.score,
    ownerName: row.owner_name,
    ageHours: Math.round((Date.now() - new Date(row.created_at)) / 3600000),
    ageLabel: ageLabel((Date.now() - new Date(row.created_at)) / 3600000),
  }));
}

// -------------------------------------------------------- objection trends ---
export function objectionTrends({ organizationId, ownerIds = 'all', since = null, limit = 10 }) {
  const owner = ownerClause(ownerIds, 'c.agent_id');
  const rows = all(
    `SELECT a.objections, a.created_at, c.agent_id, d.stage, d.id AS deal_id
     FROM call_analyses a
     JOIN calls c ON c.id = a.call_id
     LEFT JOIN deals d ON d.lead_id = c.lead_id
     WHERE a.organization_id = ?${since ? ' AND a.created_at >= ?' : ''}${owner.sql}`,
    [organizationId, ...(since ? [since] : []), ...owner.params],
  );

  const tally = new Map();
  let totalCalls = 0;
  for (const row of rows) {
    totalCalls += 1;
    const objections = parseJson(row.objections, []);
    for (const objection of objections) {
      const key = objection.category || 'other';
      const entry = tally.get(key) || { category: key, count: 0, unhandled: 0, examples: [], stages: {} };
      entry.count += 1;
      if (!objection.handled) entry.unhandled += 1;
      if (entry.examples.length < 3 && objection.text) entry.examples.push(objection.text);
      if (row.stage) entry.stages[row.stage] = (entry.stages[row.stage] || 0) + 1;
      tally.set(key, entry);
    }
  }

  return {
    totalCallsAnalysed: totalCalls,
    objections: [...tally.values()]
      .map((entry) => ({
        ...entry,
        shareOfCalls: totalCalls ? Math.round((entry.count / totalCalls) * 100) : 0,
        unhandledRate: entry.count ? Math.round((entry.unhandled / entry.count) * 100) : 0,
        commonStage: Object.entries(entry.stages).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit),
  };
}

// ----------------------------------------------------------- loss analysis ---
export function lossAnalysis({ organizationId, ownerIds = 'all', since = null }) {
  const owner = ownerClause(ownerIds, 'd.owner_id');
  const lost = all(
    `SELECT d.*, l.company_name FROM deals d LEFT JOIN leads l ON l.id = d.lead_id
     WHERE d.organization_id = ? AND d.stage = 'lost'${since ? ' AND d.closed_at >= ?' : ''}${owner.sql}
     ORDER BY d.closed_at DESC`,
    [organizationId, ...(since ? [since] : []), ...owner.params],
  );

  const byReason = new Map();
  let lostValue = 0;
  for (const deal of lost) {
    lostValue += deal.value || 0;
    const reason = deal.lost_reason || 'Not recorded';
    const entry = byReason.get(reason) || { reason, count: 0, value: 0, competitors: new Set(), stages: {} };
    entry.count += 1;
    entry.value += deal.value || 0;
    for (const competitor of parseJson(deal.competitors, [])) entry.competitors.add(competitor);
    const stageAtLoss = get(
      `SELECT from_stage FROM deal_stage_history WHERE deal_id = ? AND to_stage = 'lost' ORDER BY created_at DESC LIMIT 1`,
      [deal.id],
    )?.from_stage;
    if (stageAtLoss) entry.stages[stageAtLoss] = (entry.stages[stageAtLoss] || 0) + 1;
    byReason.set(reason, entry);
  }

  const won = get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS total FROM deals d
     WHERE d.organization_id = ? AND d.stage = 'won'${since ? ' AND d.closed_at >= ?' : ''}${owner.sql}`,
    [organizationId, ...(since ? [since] : []), ...owner.params],
  );

  return {
    lostCount: lost.length,
    lostValue,
    wonCount: won?.n || 0,
    wonValue: won?.total || 0,
    winRate: (won?.n || 0) + lost.length ? Math.round(((won?.n || 0) / ((won?.n || 0) + lost.length)) * 100) : 0,
    reasons: [...byReason.values()]
      .map((entry) => ({
        reason: entry.reason,
        count: entry.count,
        value: entry.value,
        competitors: [...entry.competitors],
        lostMostAtStage: Object.entries(entry.stages).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      }))
      .sort((a, b) => b.count - a.count),
  };
}

// -------------------------------------------------------- agent leaderboard --
export function agentPerformance({ organizationId, since, until, teamId = null }) {
  const params = [since, until, since, until, since, until, since, until, since, until, since, until, organizationId];
  const rows = all(
    `SELECT u.id, u.name, u.role, u.team_id, t.name AS team_name, u.quota_amount,
       (SELECT COUNT(*) FROM calls c WHERE c.agent_id = u.id AND c.started_at BETWEEN ? AND ?) AS calls,
       (SELECT COALESCE(SUM(c.talk_seconds), 0) FROM calls c WHERE c.agent_id = u.id AND c.started_at BETWEEN ? AND ?) AS talk_seconds,
       (SELECT COUNT(*) FROM calls c WHERE c.agent_id = u.id AND c.outcome = 'connected' AND c.started_at BETWEEN ? AND ?) AS connected,
       (SELECT COUNT(*) FROM meetings m WHERE m.organizer_id = u.id AND m.starts_at BETWEEN ? AND ?) AS meetings,
       (SELECT COUNT(*) FROM deals d WHERE d.owner_id = u.id AND d.stage = 'won' AND d.closed_at BETWEEN ? AND ?) AS won,
       (SELECT COALESCE(SUM(d.value), 0) FROM deals d WHERE d.owner_id = u.id AND d.stage = 'won' AND d.closed_at BETWEEN ? AND ?) AS revenue,
       (SELECT COUNT(*) FROM deals d WHERE d.owner_id = u.id AND d.stage NOT IN ('won','lost')) AS open_deals,
       (SELECT COALESCE(SUM(d.value), 0) FROM deals d WHERE d.owner_id = u.id AND d.stage NOT IN ('won','lost')) AS pipeline,
       (SELECT COUNT(*) FROM tasks tk WHERE tk.assignee_id = u.id AND tk.status = 'open' AND tk.due_at < datetime('now')) AS overdue_tasks,
       (SELECT COUNT(*) FROM tasks tk WHERE tk.assignee_id = u.id AND tk.status = 'done') AS tasks_done,
       (SELECT ROUND(AVG(json_extract(a.scorecard, '$.overall')), 1) FROM call_analyses a
          JOIN calls c ON c.id = a.call_id WHERE c.agent_id = u.id) AS avg_call_score,
       (SELECT ROUND(AVG(a.talk_ratio), 2) FROM call_analyses a
          JOIN calls c ON c.id = a.call_id WHERE c.agent_id = u.id) AS avg_talk_ratio,
       (SELECT ROUND(AVG(l.first_response_seconds) / 60.0, 1) FROM leads l WHERE l.owner_id = u.id
          AND l.first_response_seconds IS NOT NULL) AS avg_response_minutes
     FROM users u LEFT JOIN teams t ON t.id = u.team_id
     WHERE u.organization_id = ? AND u.status = 'active'${teamId ? ' AND u.team_id = ?' : ''}
     ORDER BY revenue DESC`,
    teamId ? [...params, teamId] : params,
  );

  return rows.map((row) => ({
    userId: row.id,
    name: row.name,
    role: row.role,
    teamId: row.team_id,
    teamName: row.team_name,
    calls: row.calls,
    connected: row.connected,
    connectRate: row.calls ? Math.round((row.connected / row.calls) * 100) : 0,
    talkMinutes: Math.round(row.talk_seconds / 60),
    meetings: row.meetings,
    dealsWon: row.won,
    revenue: row.revenue,
    quota: row.quota_amount,
    quotaAttainment: row.quota_amount ? Math.round((row.revenue / row.quota_amount) * 100) : null,
    openDeals: row.open_deals,
    pipeline: row.pipeline,
    overdueTasks: row.overdue_tasks,
    tasksDone: row.tasks_done,
    avgCallScore: row.avg_call_score,
    avgTalkRatio: row.avg_talk_ratio,
    avgResponseMinutes: row.avg_response_minutes,
  }));
}

// --------------------------------------------------------- call list today ---
/**
 * "Who should I call today?" -- a ranked, reason-annotated call list built from
 * overdue follow-ups, hot leads going cold, at-risk deals and untouched new
 * leads. This is the single most-used AI answer in the product.
 */
export function callListForToday({ organizationId, userId, limit = 12 }) {
  const candidates = new Map();
  const add = (entry, priority, reason) => {
    const existing = candidates.get(entry.leadId);
    if (existing) {
      existing.priority += priority;
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      return;
    }
    candidates.set(entry.leadId, { ...entry, priority, reasons: [reason] });
  };

  const overdue = all(
    `SELECT l.id AS leadId, l.first_name, l.last_name, l.company_name, l.phone_e164, l.temperature,
            l.next_follow_up_at, d.id AS dealId, d.value, d.stage
     FROM leads l LEFT JOIN deals d ON d.lead_id = l.id AND d.stage NOT IN ('won','lost')
     WHERE l.organization_id = ? AND l.owner_id = ? AND l.archived_at IS NULL
       AND l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at <= ?
     ORDER BY l.next_follow_up_at ASC LIMIT 25`,
    [organizationId, userId, endOfDay()],
  );
  for (const row of overdue) {
    add(mapCandidate(row), row.temperature === 'hot' ? 60 : 40,
      `Follow-up due ${new Date(row.next_follow_up_at) < new Date() ? 'and overdue' : 'today'}`);
  }

  const tasks = all(
    `SELECT t.id AS taskId, t.title, t.due_at, t.priority AS task_priority, l.id AS leadId,
            l.first_name, l.last_name, l.company_name, l.phone_e164, l.temperature,
            d.id AS dealId, d.value, d.stage
     FROM tasks t JOIN leads l ON l.id = t.lead_id
     LEFT JOIN deals d ON d.id = t.deal_id
     WHERE t.organization_id = ? AND t.assignee_id = ? AND t.status = 'open'
       AND t.type IN ('call','follow_up') AND t.due_at <= ?
     ORDER BY t.due_at ASC LIMIT 25`,
    [organizationId, userId, endOfDay()],
  );
  for (const row of tasks) {
    add(mapCandidate(row), row.task_priority === 'urgent' ? 55 : 35, `Task due: ${row.title}`);
  }

  for (const deal of dealsAtRisk({ organizationId, ownerIds: [userId], limit: 10 })) {
    if (!deal.leadId) continue;
    add({
      leadId: deal.leadId,
      name: deal.contact,
      company: deal.company,
      phone: null,
      temperature: null,
      dealId: deal.dealId,
      value: deal.value,
      stage: deal.stage,
    }, deal.riskScore >= 60 ? 50 : 25, `Deal at risk: ${deal.reasons[0]}`);
  }

  for (const lead of neverContacted({ organizationId, ownerIds: [userId], limit: 10 })) {
    add({
      leadId: lead.leadId,
      name: lead.name,
      company: lead.company,
      phone: null,
      temperature: null,
      dealId: null,
      value: 0,
      stage: null,
    }, lead.ageHours > 24 ? 45 : 30, `New lead untouched for ${ageLabel(lead.ageHours)}`);
  }

  for (const lead of needsFollowUp({ organizationId, ownerIds: [userId], days: 10, limit: 10 })) {
    if (lead.temperature !== 'hot') continue;
    add({
      leadId: lead.leadId,
      name: lead.name,
      company: lead.company,
      phone: null,
      temperature: lead.temperature,
      dealId: null,
      value: 0,
      stage: null,
    }, 48, `Hot lead going cold (${lead.daysSinceContact ?? 'no'} days since contact)`);
  }

  // One query rather than a check per source: whichever signal surfaced the
  // lead, a do-not-call flag removes them from a dial list.
  const ids = [...candidates.keys()];
  const blocked = new Set(
    ids.length
      ? all(
        `SELECT id FROM leads WHERE organization_id = ? AND do_not_call = 1
           AND ${inList('id', ids).sql}`,
        [organizationId, ...inList('id', ids).params],
      ).map((row) => row.id)
      : [],
  );

  return [...candidates.values()]
    .filter((entry) => !blocked.has(entry.leadId))
    .sort((a, b) => b.priority - a.priority || (b.value || 0) - (a.value || 0))
    .slice(0, limit)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function mapCandidate(row) {
  return {
    leadId: row.leadId,
    name: `${row.first_name} ${row.last_name || ''}`.trim(),
    company: row.company_name,
    phone: row.phone_e164,
    temperature: row.temperature,
    dealId: row.dealId,
    value: row.value || 0,
    stage: row.stage,
  };
}

// ------------------------------------------------------------ digest bundle --
/** Everything the insights page and the assistant need, in one call. */
export function insightBundle({ organizationId, userId, ownerIds, since }) {
  return {
    generatedAt: nowIso(),
    likelyToConvert: likelyToConvert({ organizationId, ownerIds, limit: 8 }),
    dealsAtRisk: dealsAtRisk({ organizationId, ownerIds, limit: 8 }),
    needsFollowUp: needsFollowUp({ organizationId, ownerIds, limit: 8 }),
    neverContacted: neverContacted({ organizationId, ownerIds, limit: 8 }),
    objectionTrends: objectionTrends({ organizationId, ownerIds, since, limit: 6 }),
    lossAnalysis: lossAnalysis({ organizationId, ownerIds, since }),
    callList: userId ? callListForToday({ organizationId, userId, limit: 8 }) : [],
  };
}

export default {
  likelyToConvert, dealsAtRisk, needsFollowUp, neverContacted, objectionTrends,
  lossAnalysis, agentPerformance, callListForToday, insightBundle,
};
