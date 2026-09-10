import { Router } from 'express';
import { all, get, parseJson, inList } from '../db/index.js';
import { startOfDay, endOfDay, nowIso, addDays } from '../lib/time.js';
import { PIPELINE_STAGES, STAGE_MAP, OPEN_STAGE_KEYS, CONNECTED_OUTCOMES, CONNECTED_OUTCOMES_SQL } from '../lib/constants.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requirePermission, visibleUserIds, ownerScopeClause } from '../middleware/auth.js';
import { forbidden, badRequest } from '../lib/errors.js';
import * as insights from '../services/ai/insights.js';
import { orgSettings } from '../services/org.js';
import { boundedInt } from '../lib/validate.js';

/**
 * The owner/agent restriction for a scoped query, as one bound parameter.
 *
 * `'all'` means organisation-wide and adds no clause; an empty list matches
 * nothing, which is what the hand-written ` AND 1=0` was for. Expanding the ids
 * into `?, ?, ?` cost one bound parameter each, and the hosted SQLite engines
 * cap a statement at 100 -- so this broke on an organisation of ~97 people.
 */
function scopeFilter(column, ids) {
  if (ids === 'all') return { sql: '', params: [] };
  const { sql, params } = inList(column, ids);
  return { sql: ` AND ${sql}`, params };
}


const router = Router();

const scopeIds = (req) => {
  const ids = visibleUserIds(req);
  return ids === 'all' ? 'all' : ids;
};

function periodOf(req, defaultDays = 30) {
  const since = req.query.since || startOfDay(new Date(), -defaultDays);
  const until = req.query.until || endOfDay();
  return { since, until };
}

// ---------------------------------------------------------- agent dashboard --
// GET /analytics/dashboard
router.get('/dashboard', requirePermission('analytics:read'), asyncHandler(async (req, res) => {
  const org = req.auth.organizationId;
  const userId = req.query.userId && req.auth.scope !== 'own' ? req.query.userId : req.auth.userId;
  const today = { from: startOfDay(), to: endOfDay() };
  const settings = orgSettings(org);

  const count = (sql, params) => get(sql, params)?.n || 0;
  const sum = (sql, params) => get(sql, params)?.total || 0;

  const callsToday = all(
    `SELECT c.*, l.first_name, l.last_name, l.company_name FROM calls c
     LEFT JOIN leads l ON l.id = c.lead_id
     WHERE c.organization_id = ? AND c.agent_id = ? AND c.started_at BETWEEN ? AND ?
     ORDER BY c.started_at DESC`,
    [org, userId, today.from, today.to],
  );

  const pipelineByStage = all(
    `SELECT stage, COUNT(*) AS deals, COALESCE(SUM(value), 0) AS value,
            COALESCE(SUM(value * probability / 100.0), 0) AS weighted
     FROM deals WHERE organization_id = ? AND owner_id = ? AND stage NOT IN ('won','lost')
     GROUP BY stage`,
    [org, userId],
  );

  res.json({
    period: today,
    today: {
      callsMade: callsToday.length,
      callsConnected: callsToday.filter((c) => CONNECTED_OUTCOMES.includes(c.outcome)).length,
      callsMissed: callsToday.filter((c) => ['missed', 'no_answer'].includes(c.status)).length,
      talkMinutes: Math.round(callsToday.reduce((sum2, c) => sum2 + (c.talk_seconds || 0), 0) / 60),
      callTarget: Math.round((settings.quotas?.monthlyCallTarget || 400) / 21),
      recentCalls: callsToday.slice(0, 8).map((c) => ({
        id: c.id,
        contactName: c.first_name ? `${c.first_name} ${c.last_name || ''}`.trim() : null,
        companyName: c.company_name,
        outcome: c.outcome,
        status: c.status,
        durationSeconds: c.duration_seconds,
        startedAt: c.started_at,
        aiStatus: c.ai_status,
      })),
    },
    leads: {
      total: count(`SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND owner_id = ? AND archived_at IS NULL`, [org, userId]),
      new: count(`SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND owner_id = ? AND status = 'new' AND archived_at IS NULL`, [org, userId]),
      hot: count(`SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND owner_id = ? AND temperature = 'hot' AND archived_at IS NULL`, [org, userId]),
      warm: count(`SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND owner_id = ? AND temperature = 'warm' AND archived_at IS NULL`, [org, userId]),
      cold: count(`SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND owner_id = ? AND temperature = 'cold' AND archived_at IS NULL`, [org, userId]),
      newThisWeek: count(`SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND owner_id = ? AND created_at >= ?`, [org, userId, startOfDay(new Date(), -7)]),
      uncontacted: count(`SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND owner_id = ? AND last_contacted_at IS NULL AND archived_at IS NULL`, [org, userId]),
    },
    followUps: {
      pending: count(`SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND owner_id = ? AND next_follow_up_at IS NOT NULL AND next_follow_up_at <= ?`, [org, userId, endOfDay()]),
      overdue: count(`SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND owner_id = ? AND next_follow_up_at IS NOT NULL AND next_follow_up_at < ?`, [org, userId, startOfDay()]),
      upcoming: all(
        `SELECT l.id, l.first_name, l.last_name, l.company_name, l.next_follow_up_at, l.temperature
         FROM leads l WHERE l.organization_id = ? AND l.owner_id = ? AND l.next_follow_up_at IS NOT NULL
           AND l.next_follow_up_at >= ? ORDER BY l.next_follow_up_at ASC LIMIT 8`,
        [org, userId, startOfDay()],
      ).map((l) => ({
        leadId: l.id, name: `${l.first_name} ${l.last_name || ''}`.trim(),
        company: l.company_name, at: l.next_follow_up_at, temperature: l.temperature,
      })),
    },
    tasks: {
      dueToday: count(`SELECT COUNT(*) AS n FROM tasks WHERE organization_id = ? AND assignee_id = ? AND status = 'open' AND due_at BETWEEN ? AND ?`, [org, userId, today.from, today.to]),
      overdue: count(`SELECT COUNT(*) AS n FROM tasks WHERE organization_id = ? AND assignee_id = ? AND status = 'open' AND due_at < ?`, [org, userId, today.from]),
      open: count(`SELECT COUNT(*) AS n FROM tasks WHERE organization_id = ? AND assignee_id = ? AND status IN ('open','in_progress')`, [org, userId]),
      list: all(
        `SELECT t.*, l.first_name, l.last_name, l.company_name FROM tasks t
         LEFT JOIN leads l ON l.id = t.lead_id
         WHERE t.organization_id = ? AND t.assignee_id = ? AND t.status = 'open'
         ORDER BY t.due_at ASC LIMIT 8`,
        [org, userId],
      ).map((t) => ({
        id: t.id, title: t.title, type: t.type, priority: t.priority, dueAt: t.due_at,
        leadId: t.lead_id, source: t.source, aiReason: t.ai_reason,
        contactName: t.first_name ? `${t.first_name} ${t.last_name || ''}`.trim() : null,
        companyName: t.company_name,
      })),
    },
    deals: {
      open: count(`SELECT COUNT(*) AS n FROM deals WHERE organization_id = ? AND owner_id = ? AND stage NOT IN ('won','lost')`, [org, userId]),
      pipelineValue: sum(`SELECT COALESCE(SUM(value), 0) AS total FROM deals WHERE organization_id = ? AND owner_id = ? AND stage NOT IN ('won','lost')`, [org, userId]),
      weightedForecast: Math.round(pipelineByStage.reduce((s, r) => s + r.weighted, 0)),
      wonThisMonth: count(`SELECT COUNT(*) AS n FROM deals WHERE organization_id = ? AND owner_id = ? AND stage = 'won' AND closed_at >= ?`, [org, userId, startOfDay(new Date(), -30)]),
      revenueThisMonth: sum(`SELECT COALESCE(SUM(value), 0) AS total FROM deals WHERE organization_id = ? AND owner_id = ? AND stage = 'won' AND closed_at >= ?`, [org, userId, startOfDay(new Date(), -30)]),
      byStage: PIPELINE_STAGES.filter((s) => !s.terminal).map((stage) => {
        const row = pipelineByStage.find((r) => r.stage === stage.key);
        return { stage: stage.key, label: stage.label, deals: row?.deals || 0, value: row?.value || 0 };
      }),
      closingSoon: all(
        `SELECT d.id, d.name, d.value, d.stage, d.probability, d.expected_close_date, l.company_name
         FROM deals d LEFT JOIN leads l ON l.id = d.lead_id
         WHERE d.organization_id = ? AND d.owner_id = ? AND d.stage NOT IN ('won','lost')
           AND d.expected_close_date IS NOT NULL AND d.expected_close_date <= ?
         ORDER BY d.expected_close_date ASC LIMIT 6`,
        [org, userId, addDays(30)],
      ),
    },
    quota: {
      target: get('SELECT quota_amount FROM users WHERE id = ?', [userId])?.quota_amount || 0,
      achieved: sum(`SELECT COALESCE(SUM(value), 0) AS total FROM deals WHERE organization_id = ? AND owner_id = ? AND stage = 'won' AND closed_at >= ?`, [org, userId, startOfDay(new Date(), -30)]),
    },
    conversations: all(
      `SELECT c.id, c.started_at, c.duration_seconds, a.summary, a.sentiment,
              json_extract(a.scorecard, '$.overall') AS score,
              l.id AS lead_id, l.first_name, l.last_name, l.company_name
       FROM calls c JOIN call_analyses a ON a.call_id = c.id
       LEFT JOIN leads l ON l.id = c.lead_id
       WHERE c.organization_id = ? AND c.agent_id = ? ORDER BY c.started_at DESC LIMIT 5`,
      [org, userId],
    ).map((row) => ({
      callId: row.id,
      leadId: row.lead_id,
      contactName: row.first_name ? `${row.first_name} ${row.last_name || ''}`.trim() : null,
      companyName: row.company_name,
      startedAt: row.started_at,
      durationSeconds: row.duration_seconds,
      summary: row.summary,
      sentiment: row.sentiment,
      score: row.score,
    })),
    pendingApprovals: get(
      `SELECT COUNT(*) AS n FROM ai_suggestions s
       WHERE s.organization_id = ? AND s.status = 'pending'
         AND (s.entity_id IN (SELECT id FROM leads WHERE owner_id = ?)
              OR s.entity_id IN (SELECT id FROM deals WHERE owner_id = ?))`,
      [org, userId, userId],
    )?.n || 0,
    callList: insights.callListForToday({ organizationId: org, userId, limit: 6 }),
  });
}));

// -------------------------------------------------------- manager dashboard --
// GET /analytics/team
router.get('/team', requirePermission('analytics:team'), asyncHandler(async (req, res) => {
  const org = req.auth.organizationId;
  const { since, until } = periodOf(req, 30);
  // A manager may only ask about their own team. The client-supplied teamId was
  // trusted outright, so a manager could read another team's per-agent revenue,
  // quota and call scores by naming its id.
  let teamId = req.query.teamId || null;
  if (req.auth.scope !== 'org') {
    if (teamId && teamId !== req.auth.teamId) throw forbidden('You can only view your own team');
    teamId = req.auth.teamId || null;
  }

  const agents = insights.agentPerformance({ organizationId: org, since, until, teamId });
  const ids = agents.map((a) => a.userId);
  const owner = scopeFilter('owner_id', ids);
  const agent = scopeFilter('agent_id', ids);
  const callAgent = scopeFilter('c.agent_id', ids);
  const assignee = scopeFilter('assignee_id', ids);

  const stageTotals = all(
    `SELECT stage, COUNT(*) AS deals, COALESCE(SUM(value), 0) AS value,
            COALESCE(SUM(value * probability / 100.0), 0) AS weighted
     FROM deals WHERE organization_id = ?${owner.sql} AND stage NOT IN ('won','lost') GROUP BY stage`,
    [org, ...owner.params],
  );

  const callsByDay = all(
    `SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS calls,
            SUM(CASE WHEN outcome IN ${CONNECTED_OUTCOMES_SQL} THEN 1 ELSE 0 END) AS connected,
            COALESCE(SUM(talk_seconds), 0) AS talk_seconds
     FROM calls WHERE organization_id = ?${agent.sql} AND started_at BETWEEN ? AND ?
     GROUP BY day ORDER BY day ASC`,
    [org, ...agent.params, since, until],
  );

  const responseTimes = all(
    `SELECT owner_id, ROUND(AVG(first_response_seconds) / 60.0, 1) AS minutes, COUNT(*) AS leads
     FROM leads WHERE organization_id = ?${owner.sql} AND first_response_seconds IS NOT NULL
     GROUP BY owner_id`,
    [org, ...owner.params],
  );

  const callQuality = all(
    `SELECT c.agent_id, ROUND(AVG(json_extract(a.scorecard, '$.overall')), 1) AS avg_score,
            ROUND(AVG(a.talk_ratio), 2) AS avg_talk_ratio, COUNT(*) AS analysed
     FROM call_analyses a JOIN calls c ON c.id = a.call_id
     WHERE a.organization_id = ?${callAgent.sql}
       AND a.created_at BETWEEN ? AND ?
     GROUP BY c.agent_id`,
    [org, ...callAgent.params, since, until],
  );

  const followUpCompletion = all(
    `SELECT assignee_id,
            SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN status = 'open' AND due_at < ? THEN 1 ELSE 0 END) AS overdue,
            COUNT(*) AS total
     FROM tasks WHERE organization_id = ?${assignee.sql}
       AND created_at >= ? GROUP BY assignee_id`,
    [nowIso(), org, ...assignee.params, since],
  );

  res.json({
    period: { since, until },
    teams: all('SELECT id, name, region FROM teams WHERE organization_id = ?', [org]),
    agents: agents.map((agent) => {
      const quality = callQuality.find((q) => q.agent_id === agent.userId);
      const response = responseTimes.find((r) => r.owner_id === agent.userId);
      const followUp = followUpCompletion.find((f) => f.assignee_id === agent.userId);
      return {
        ...agent,
        avgCallScore: quality?.avg_score ?? agent.avgCallScore,
        avgTalkRatio: quality?.avg_talk_ratio ?? agent.avgTalkRatio,
        callsAnalysed: quality?.analysed || 0,
        responseMinutes: response?.minutes ?? null,
        followUpCompletion: followUp?.total ? Math.round((followUp.done / followUp.total) * 100) : null,
        overdueTasks: followUp?.overdue ?? agent.overdueTasks,
      };
    }),
    totals: {
      calls: callsByDay.reduce((s, d) => s + d.calls, 0),
      connected: callsByDay.reduce((s, d) => s + d.connected, 0),
      talkHours: Math.round(callsByDay.reduce((s, d) => s + d.talk_seconds, 0) / 360) / 10,
      revenue: agents.reduce((s, a) => s + a.revenue, 0),
      pipeline: stageTotals.reduce((s, r) => s + r.value, 0),
      weightedForecast: Math.round(stageTotals.reduce((s, r) => s + r.weighted, 0)),
      dealsWon: agents.reduce((s, a) => s + a.dealsWon, 0),
      quota: agents.reduce((s, a) => s + (a.quota || 0), 0),
    },
    pipelineByStage: PIPELINE_STAGES.map((stage) => {
      const row = stageTotals.find((r) => r.stage === stage.key);
      return { ...stage, deals: row?.deals || 0, value: row?.value || 0, weighted: Math.round(row?.weighted || 0) };
    }),
    callsByDay,
    // `ids` is passed through even when empty. It used to become 'all' -- so a
    // team with no active members, or a manager whose team is empty, got the
    // whole organisation's at-risk deals, loss reasons and objections back
    // beside a set of zeroed totals. ownerClause() already reads [] as
    // "matches nothing", which is what the rest of this handler does.
    winLoss: insights.lossAnalysis({ organizationId: org, ownerIds: ids, since }),
    objections: insights.objectionTrends({ organizationId: org, ownerIds: ids, since, limit: 8 }),
    dealsAtRisk: insights.dealsAtRisk({ organizationId: org, ownerIds: ids, limit: 10 }),
  });
}));

// GET /analytics/funnel
router.get('/funnel', requirePermission('analytics:read'), asyncHandler(async (req, res) => {
  const ids = scopeIds(req);
  const { since } = periodOf(req, 90);
  const dealOwner = scopeFilter('d.owner_id', ids);
  const params = [req.auth.organizationId, since, ...dealOwner.params];

  // Count how many deals ever reached each stage, not how many sit there now:
  // that is the only honest way to measure stage-to-stage conversion.
  const reached = all(
    `SELECT h.to_stage AS stage, COUNT(DISTINCT h.deal_id) AS deals
     FROM deal_stage_history h JOIN deals d ON d.id = h.deal_id
     WHERE h.organization_id = ? AND h.created_at >= ?${dealOwner.sql}
     GROUP BY h.to_stage`,
    params,
  );

  const stages = PIPELINE_STAGES.filter((s) => s.key !== 'lost').map((stage) => ({
    stage: stage.key,
    label: stage.label,
    deals: reached.find((r) => r.stage === stage.key)?.deals || 0,
  }));
  // The denominator is the first stage that has any deals, not `new_lead`.
  // Keying off stage zero looked right until the database was emptied: deals
  // created afterwards go straight to the stage they are actually at, so
  // `new_lead` sits at zero and every single conversionFromTop came back null
  // -- the whole column dead, including for stages holding real deals.
  const baseline = stages.find((stage) => stage.deals > 0);
  const withRates = stages.map((stage, index) => ({
    ...stage,
    conversionFromPrevious: index === 0 || !stages[index - 1].deals
      ? null
      : Math.round((stage.deals / stages[index - 1].deals) * 100),
    conversionFromTop: baseline ? Math.round((stage.deals / baseline.deals) * 100) : null,
  }));

  // Named, because "conversion from top" means something different when the
  // top of the funnel is not where the deals came in.
  res.json({ funnel: withRates, baselineStage: baseline?.stage ?? null, since });
}));

// GET /analytics/reports/:report
const REPORTS = {
  sales_performance: (org, ids, since, until) => {
    const scope = scopeFilter('u.id', ids);
    return all(
    `SELECT u.name AS agent, COUNT(DISTINCT d.id) AS deals_won, COALESCE(SUM(d.value), 0) AS revenue,
            u.quota_amount AS quota
     FROM users u LEFT JOIN deals d ON d.owner_id = u.id AND d.stage = 'won' AND d.closed_at BETWEEN ? AND ?
     WHERE u.organization_id = ?${scope.sql}
     GROUP BY u.id ORDER BY revenue DESC`,
    [since, until, org, ...scope.params],
    );
  },
  calls: (org, ids, since, until) => {
    const scope = scopeFilter('c.agent_id', ids);
    return all(
    `SELECT substr(c.started_at, 1, 10) AS day, u.name AS agent, COUNT(*) AS calls,
            SUM(CASE WHEN c.outcome IN ${CONNECTED_OUTCOMES_SQL} THEN 1 ELSE 0 END) AS connected,
            ROUND(COALESCE(SUM(c.talk_seconds), 0) / 60.0, 1) AS talk_minutes
     FROM calls c LEFT JOIN users u ON u.id = c.agent_id
     WHERE c.organization_id = ? AND c.started_at BETWEEN ? AND ?${scope.sql}
     GROUP BY day, c.agent_id ORDER BY day DESC`,
    [org, since, until, ...scope.params],
    );
  },
  // The window is applied, not just echoed. These two took (org, ids) and
  // filtered on nothing, while the handler reported `period` on every
  // response -- so a report for a window entirely in the future came back
  // with all-time rows under a 2030 heading.
  lead_sources: (org, ids, since, until) => {
    const scope = scopeFilter('l.owner_id', ids);
    return all(
    `SELECT l.source, COUNT(*) AS leads,
            SUM(CASE WHEN l.status = 'customer' THEN 1 ELSE 0 END) AS converted,
            COALESCE(SUM(l.deal_value), 0) AS pipeline_value,
            ROUND(AVG(l.score), 1) AS avg_score
     FROM leads l WHERE l.organization_id = ? AND l.archived_at IS NULL
       AND l.created_at BETWEEN ? AND ?${scope.sql}
     GROUP BY l.source ORDER BY leads DESC`,
    [org, since, until, ...scope.params],
    );
  },
  deal_velocity: (org, ids, since, until) => {
    const scope = scopeFilter('d.owner_id', ids);
    return all(
    `SELECT h.to_stage AS stage,
            ROUND(AVG(julianday(COALESCE(next_h.created_at, datetime('now'))) - julianday(h.created_at)), 1) AS avg_days,
            COUNT(*) AS transitions
     FROM deal_stage_history h
     JOIN deals d ON d.id = h.deal_id
     LEFT JOIN deal_stage_history next_h ON next_h.deal_id = h.deal_id AND next_h.created_at > h.created_at
     WHERE h.organization_id = ? AND h.created_at BETWEEN ? AND ?${scope.sql}
     GROUP BY h.to_stage`,
    [org, since, until, ...scope.params],
    );
  },
  follow_up_performance: (org, ids, since) => {
    const scope = scopeFilter('t.assignee_id', ids);
    return all(
    `SELECT u.name AS agent, COUNT(t.id) AS tasks,
            SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN t.status = 'open' AND t.due_at < datetime('now') THEN 1 ELSE 0 END) AS overdue,
            SUM(CASE WHEN t.source = 'ai' THEN 1 ELSE 0 END) AS ai_created
     FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
     WHERE t.organization_id = ? AND t.created_at >= ?${scope.sql}
     GROUP BY t.assignee_id ORDER BY completed DESC`,
    [org, since, ...scope.params],
    );
  },
  ai_call_insights: (org, ids, since) => {
    const scope = scopeFilter('c.agent_id', ids);
    return all(
    `SELECT a.sentiment, COUNT(*) AS calls,
            ROUND(AVG(json_extract(a.scorecard, '$.overall')), 1) AS avg_score,
            ROUND(AVG(a.talk_ratio), 2) AS avg_talk_ratio,
            ROUND(AVG(json_array_length(a.objections)), 2) AS avg_objections,
            ROUND(AVG(json_array_length(a.buying_signals)), 2) AS avg_buying_signals
     FROM call_analyses a JOIN calls c ON c.id = a.call_id
     WHERE a.organization_id = ? AND a.created_at >= ?${scope.sql}
     GROUP BY a.sentiment`,
    [org, since, ...scope.params],
    );
  },
  revenue: (org, ids, since, until) => {
    const scope = scopeFilter('d.owner_id', ids);
    return all(
    `SELECT substr(d.closed_at, 1, 7) AS month, COUNT(*) AS deals, COALESCE(SUM(d.value), 0) AS revenue
     FROM deals d WHERE d.organization_id = ? AND d.stage = 'won' AND d.closed_at BETWEEN ? AND ?
       ${scope.sql}
     GROUP BY month ORDER BY month ASC`,
    [org, since, until, ...scope.params],
    );
  },
  win_loss: (org, ids, since) => {
    const analysis = insights.lossAnalysis({ organizationId: org, ownerIds: ids, since });
    return analysis.reasons.map((r) => ({
      reason: r.reason, deals: r.count, value: r.value,
      competitors: r.competitors.join(', '), lost_most_at_stage: r.lostMostAtStage,
    }));
  },
};

router.get('/reports/:report', requirePermission('report:export'), asyncHandler(async (req, res) => {
  // Object.hasOwn, not a truthiness test on the lookup. Every object inherits
  // `toString`, `constructor`, `valueOf` and friends, and all of them are
  // truthy, so `/analytics/reports/toString` passed the guard: some returned
  // 500s, and `toString` produced a 200 whose `rows` was the string
  // "[object Undefined]" and whose `count` was that string's length, while
  // `constructor` echoed the internal organisation id back to the caller.
  if (!Object.hasOwn(REPORTS, req.params.report)) {
    throw badRequest(`Unknown report. Available: ${Object.keys(REPORTS).join(', ')}`);
  }
  const builder = REPORTS[req.params.report];
  const { since, until } = periodOf(req, boundedInt(req.query.days, 90, { max: 3650 }));
  const rows = builder(req.auth.organizationId, scopeIds(req), since, until) || [];

  const format = String(req.query.format || 'json').toLowerCase();
  if (format === 'csv') {
    const csv = toCsv(rows, REPORT_COLUMNS[req.params.report]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.report}-${nowIso().slice(0, 10)}.csv"`);
    return res.send(csv);
  }
  return res.json({ report: req.params.report, period: { since, until }, rows, count: rows.length });
}));

// GET /analytics/reports  -- catalogue
router.get('/reports', requirePermission('report:export'), asyncHandler(async (req, res) => {
  res.json({
    reports: [
      { key: 'sales_performance', label: 'Sales performance', description: 'Revenue and deals won per agent against quota.' },
      { key: 'conversion_funnel', label: 'Conversion funnel', description: 'Stage-to-stage conversion for every deal that entered the pipeline.', endpoint: '/analytics/funnel' },
      { key: 'revenue', label: 'Revenue by month', description: 'Closed-won revenue over time.' },
      { key: 'calls', label: 'Call activity', description: 'Calls, connects and talk time per agent per day.' },
      { key: 'lead_sources', label: 'Lead sources', description: 'Volume, conversion and value by acquisition source.' },
      { key: 'deal_velocity', label: 'Deal velocity', description: 'Average days spent in each pipeline stage.' },
      { key: 'follow_up_performance', label: 'Follow-up performance', description: 'Task completion and overdue rates, including AI-created tasks.' },
      { key: 'win_loss', label: 'Win/loss analysis', description: 'Loss reasons, competitors involved and the stage deals died at.' },
      { key: 'ai_call_insights', label: 'AI call insights', description: 'Call scores, talk ratio, objections and buying signals by sentiment.' },
    ],
    formats: ['json', 'csv'],
  });
}));

/**
 * The columns each report produces, so an export with no rows still has a
 * header line. Deriving them from the rows meant a report that matched nothing
 * downloaded as a 0-byte file, which opens as a corrupt sheet rather than an
 * empty one -- and gave the operator no way to tell "no data" from "export
 * broke". Aliases match the SELECT in REPORTS above.
 */
const REPORT_COLUMNS = {
  sales_performance: ['agent', 'deals_won', 'revenue', 'quota'],
  calls: ['day', 'agent', 'calls', 'connected', 'talk_minutes'],
  lead_sources: ['source', 'leads', 'converted', 'pipeline_value', 'avg_score'],
  deal_velocity: ['stage', 'avg_days', 'transitions'],
  follow_up_performance: ['agent', 'tasks', 'completed', 'overdue', 'ai_created'],
  ai_call_insights: ['sentiment', 'calls', 'avg_score', 'avg_talk_ratio', 'avg_objections', 'avg_buying_signals'],
  revenue: ['month', 'deals', 'revenue'],
  win_loss: ['reason', 'deals', 'value', 'competitors', 'lost_most_at_stage'],
};

function toCsv(rows, columns) {
  // Still derived from the rows when there are any: a report whose SELECT
  // changes should not silently drop a column because this list went stale.
  const headers = rows.length
    ? [...new Set(rows.flatMap((row) => Object.keys(row)))]
    : (columns || []);
  if (!headers.length) return '';
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((h) => escape(row[h])).join(','))].join('\n');
}

export default router;
