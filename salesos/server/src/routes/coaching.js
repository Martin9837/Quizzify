import { Router } from 'express';
import { all, get, parseJson } from '../db/index.js';
import { startOfDay } from '../lib/time.js';
import { COACHING_DIMENSIONS } from '../lib/constants.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requirePermission, ownerScopeClause, assertRecordAccess, visibleUserIds } from '../middleware/auth.js';
import { notFound } from '../lib/errors.js';
import { boundedInt, finiteNumber } from '../lib/validate.js';

const router = Router();

/**
 * Call quality and coaching.
 *
 * Scores come from the same analysis that produced the summary, so coaching is
 * always tied to a specific conversation an agent can go back and listen to --
 * a score with no transcript behind it is just an opinion.
 */

// GET /coaching/overview
router.get('/overview', requirePermission('coaching:read'), asyncHandler(async (req, res) => {
  const scope = ownerScopeClause(req, 'c.agent_id');
  const since = req.query.since || startOfDay(new Date(), -30);
  const params = [req.auth.organizationId, ...scope.params, since];

  const rows = all(
    `SELECT c.agent_id, u.name AS agent_name, a.scorecard, a.coaching, a.talk_ratio, a.sentiment,
            a.objections, a.buying_signals, c.id AS call_id, c.started_at, c.duration_seconds,
            l.first_name, l.last_name, l.company_name
     FROM call_analyses a
     JOIN calls c ON c.id = a.call_id
     LEFT JOIN users u ON u.id = c.agent_id
     LEFT JOIN leads l ON l.id = c.lead_id
     WHERE a.organization_id = ?${scope.sql} AND a.created_at >= ?
     ORDER BY a.created_at DESC`,
    params,
  );

  const byAgent = new Map();
  for (const row of rows) {
    const scorecard = parseJson(row.scorecard, {});
    const coaching = parseJson(row.coaching, {});
    const entry = byAgent.get(row.agent_id) || {
      agentId: row.agent_id,
      agentName: row.agent_name,
      calls: 0,
      dimensions: Object.fromEntries(COACHING_DIMENSIONS.map((d) => [d.key, { total: 0, count: 0 }])),
      overallTotal: 0,
      talkRatioTotal: 0,
      improvements: new Map(),
      strengths: new Map(),
      bestCall: null,
      worstCall: null,
    };
    entry.calls += 1;
    entry.overallTotal += scorecard.overall || 0;
    entry.talkRatioTotal += row.talk_ratio || 0;
    for (const dimension of COACHING_DIMENSIONS) {
      if (scorecard[dimension.key] !== undefined) {
        entry.dimensions[dimension.key].total += scorecard[dimension.key];
        entry.dimensions[dimension.key].count += 1;
      }
    }
    for (const item of coaching.improvements || []) {
      entry.improvements.set(item, (entry.improvements.get(item) || 0) + 1);
    }
    for (const item of coaching.strengths || []) {
      entry.strengths.set(item, (entry.strengths.get(item) || 0) + 1);
    }
    const callSummary = {
      callId: row.call_id,
      score: scorecard.overall || 0,
      startedAt: row.started_at,
      contactName: row.first_name ? `${row.first_name} ${row.last_name || ''}`.trim() : null,
      companyName: row.company_name,
    };
    if (!entry.bestCall || callSummary.score > entry.bestCall.score) entry.bestCall = callSummary;
    if (!entry.worstCall || callSummary.score < entry.worstCall.score) entry.worstCall = callSummary;
    byAgent.set(row.agent_id, entry);
  }

  const agents = [...byAgent.values()].map((entry) => ({
    agentId: entry.agentId,
    agentName: entry.agentName,
    callsAnalysed: entry.calls,
    averageScore: entry.calls ? Math.round(entry.overallTotal / entry.calls) : 0,
    averageTalkRatio: entry.calls ? Math.round((entry.talkRatioTotal / entry.calls) * 100) / 100 : null,
    dimensions: Object.fromEntries(
      Object.entries(entry.dimensions).map(([key, value]) => [key, value.count ? Math.round(value.total / value.count) : null]),
    ),
    topImprovements: [...entry.improvements.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([text, count]) => ({ text, occurrences: count })),
    topStrengths: [...entry.strengths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([text, count]) => ({ text, occurrences: count })),
    bestCall: entry.bestCall,
    worstCall: entry.worstCall,
  })).sort((a, b) => b.averageScore - a.averageScore);

  // Team-wide weakest dimension is the highest-leverage thing to coach.
  const teamDimensions = COACHING_DIMENSIONS.map((dimension) => {
    const values = agents.map((a) => a.dimensions[dimension.key]).filter((v) => v !== null);
    return {
      key: dimension.key,
      label: dimension.label,
      average: values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : null,
    };
  });

  res.json({
    since,
    dimensions: COACHING_DIMENSIONS,
    agents,
    teamDimensions,
    weakestDimension: teamDimensions.filter((d) => d.average !== null).sort((a, b) => a.average - b.average)[0] || null,
    callsAnalysed: rows.length,
  });
}));

// GET /coaching/calls  -- scored call list for review
router.get('/calls', requirePermission('coaching:read'), asyncHandler(async (req, res) => {
  const scope = ownerScopeClause(req, 'c.agent_id');
  const params = [req.auth.organizationId, ...scope.params];
  const filters = [];
  if (req.query.agentId) {
    assertRecordAccess(req, req.query.agentId);
    filters.push('c.agent_id = ?');
    params.push(req.query.agentId);
  }
  if (req.query.maxScore) {
    filters.push(`json_extract(a.scorecard, '$.overall') <= ?`);
    params.push(finiteNumber(req.query.maxScore));
  }
  if (req.query.dimension && req.query.dimensionBelow) {
    filters.push(`json_extract(a.scorecard, '$.${String(req.query.dimension).replace(/[^a-z_]/g, '')}') <= ?`);
    params.push(finiteNumber(req.query.dimensionBelow));
  }

  const rows = all(
    `SELECT c.id AS call_id, c.started_at, c.duration_seconds, c.agent_id, u.name AS agent_name,
            l.first_name, l.last_name, l.company_name, a.scorecard, a.coaching, a.sentiment,
            a.talk_ratio, a.summary, a.objections
     FROM call_analyses a JOIN calls c ON c.id = a.call_id
     LEFT JOIN users u ON u.id = c.agent_id LEFT JOIN leads l ON l.id = c.lead_id
     WHERE a.organization_id = ?${scope.sql}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}
     ORDER BY json_extract(a.scorecard, '$.overall') ASC LIMIT ?`,
    [...params, boundedInt(req.query.limit, 40, { max: 200 })],
  );

  res.json({
    calls: rows.map((row) => ({
      callId: row.call_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      contactName: row.first_name ? `${row.first_name} ${row.last_name || ''}`.trim() : null,
      companyName: row.company_name,
      startedAt: row.started_at,
      durationSeconds: row.duration_seconds,
      sentiment: row.sentiment,
      talkRatio: row.talk_ratio,
      summary: row.summary,
      scorecard: parseJson(row.scorecard, {}),
      coaching: parseJson(row.coaching, {}),
      objections: parseJson(row.objections, []),
    })),
  });
}));

// GET /coaching/agents/:agentId  -- one agent's coaching detail
router.get('/agents/:agentId', requirePermission('coaching:read'), asyncHandler(async (req, res) => {
  const ids = visibleUserIds(req);
  if (ids !== 'all' && !ids.includes(req.params.agentId)) throw notFound('Agent');
  const agent = get('SELECT id, name, role, team_id FROM users WHERE id = ? AND organization_id = ?',
    [req.params.agentId, req.auth.organizationId]);
  if (!agent) throw notFound('Agent');

  const rows = all(
    `SELECT a.*, c.id AS call_id, c.started_at, c.duration_seconds, l.company_name
     FROM call_analyses a JOIN calls c ON c.id = a.call_id LEFT JOIN leads l ON l.id = c.lead_id
     WHERE c.agent_id = ? AND a.organization_id = ? ORDER BY a.created_at DESC LIMIT 60`,
    [agent.id, req.auth.organizationId],
  );

  // Trend over time: the same dimension scored call by call.
  const trend = rows.slice().reverse().map((row) => {
    const scorecard = parseJson(row.scorecard, {});
    return {
      callId: row.call_id,
      at: row.started_at,
      overall: scorecard.overall || 0,
      ...Object.fromEntries(COACHING_DIMENSIONS.map((d) => [d.key, scorecard[d.key] ?? null])),
    };
  });

  const objectionHandling = rows.reduce((acc, row) => {
    for (const objection of parseJson(row.objections, [])) {
      const entry = acc[objection.category] || { category: objection.category, total: 0, handled: 0 };
      entry.total += 1;
      if (objection.handled) entry.handled += 1;
      acc[objection.category] = entry;
    }
    return acc;
  }, {});

  res.json({
    agent: { id: agent.id, name: agent.name, role: agent.role, teamId: agent.team_id },
    callsAnalysed: rows.length,
    trend,
    latestCoaching: rows.length ? parseJson(rows[0].coaching, {}) : null,
    objectionHandling: Object.values(objectionHandling).map((entry) => ({
      ...entry,
      handledRate: entry.total ? Math.round((entry.handled / entry.total) * 100) : 0,
    })).sort((a, b) => b.total - a.total),
    recommendations: buildRecommendations(rows),
  });
}));

/** Turn repeated per-call feedback into a small number of coaching priorities. */
function buildRecommendations(rows) {
  const tally = new Map();
  for (const row of rows.slice(0, 20)) {
    const coaching = parseJson(row.coaching, {});
    for (const item of [...(coaching.improvements || []), ...(coaching.missed_opportunities || [])]) {
      tally.set(item, (tally.get(item) || 0) + 1);
    }
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([text, count]) => ({
      recommendation: text,
      appearedInCalls: count,
      priority: count >= 5 ? 'high' : count >= 3 ? 'medium' : 'low',
    }));
}

export default router;
