import { all, get, insert, run, parseJson, inList } from '../../db/index.js';
import { id } from '../../lib/ids.js';
import { nowIso, startOfDay, endOfDay } from '../../lib/time.js';
import { visibilityScope } from '../../lib/permissions.js';
import * as insights from './insights.js';
import * as searchService from '../search/index.js';
import anthropic from './provider.anthropic.js';
import config from '../../config.js';
import logger from '../../lib/logger.js';
import { CONNECTED_OUTCOMES_SQL } from '../../lib/constants.js';

/**
 * The AI sales assistant.
 *
 * Every question is answered from a set of data tools. Each tool applies the
 * caller's own visibility scope before returning anything, so the assistant
 * physically cannot surface a record the user is not allowed to read -- the
 * permission check lives in the data layer, not in the prompt.
 *
 * When a model is configured the tools are exposed as Anthropic tool
 * definitions and the model decides which to call. Without a model, a
 * deterministic intent router picks the same tools and formats the answer. Both
 * paths return the same shape.
 */

// ------------------------------------------------------------ scope helper ---
export function scopeFor(user) {
  const scope = visibilityScope(user);
  if (scope === 'org') return { type: 'org', ownerIds: 'all' };
  if (scope === 'team') {
    const teammates = all(
      'SELECT id FROM users WHERE organization_id = ? AND (team_id = ? OR id = ?)',
      [user.organizationId, user.teamId || '', user.id],
    ).map((u) => u.id);
    return { type: 'team', ownerIds: teammates, userIds: teammates };
  }
  return { type: 'own', ownerIds: [user.id], userId: user.id };
}

// ------------------------------------------------------------------ tools ----
function buildTools(user) {
  const scope = scopeFor(user);
  const org = user.organizationId;
  const isManager = scope.type !== 'own';

  const tools = {
    search_crm: {
      description: 'Full-text search across leads, deals, calls, transcripts, emails, tasks, notes and meetings. Use this to find records by name, company, or something that was said.',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          entity_types: { type: 'array', items: { type: 'string', enum: ['lead', 'company', 'deal', 'call', 'transcript', 'email', 'task', 'note', 'meeting'] } },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
      run: ({ query, entity_types: entityTypes, limit }) => searchService.search({
        organizationId: org,
        query,
        entityTypes,
        scope,
        limit: Math.min(limit || 15, 40),
      }),
    },

    get_lead: {
      description: 'Full CRM profile for one lead: contact details, deal, recent calls with their AI summaries, open tasks and notes. Accepts a lead id or a name/company to match.',
      schema: {
        type: 'object',
        properties: { lead_id: { type: 'string' }, name_or_company: { type: 'string' } },
      },
      run: ({ lead_id: leadId, name_or_company: nameOrCompany }) => leadProfile({ org, scope, leadId, nameOrCompany }),
    },

    list_leads: {
      description: 'List leads with filters. Use for questions like "my hot leads" or "leads from the webinar that are still new".',
      schema: {
        type: 'object',
        properties: {
          temperature: { type: 'string', enum: ['hot', 'warm', 'cold'] },
          status: { type: 'string' },
          source: { type: 'string' },
          not_contacted_days: { type: 'number' },
          limit: { type: 'number' },
        },
      },
      run: (args) => listLeads({ org, scope, ...args }),
    },

    list_deals: {
      description: 'List deals with filters (stage, minimum value, closing before a date). Use for forecast questions.',
      schema: {
        type: 'object',
        properties: {
          stage: { type: 'string' },
          min_value: { type: 'number' },
          closing_before: { type: 'string' },
          open_only: { type: 'boolean' },
          limit: { type: 'number' },
        },
      },
      run: (args) => listDeals({ org, scope, ...args }),
    },

    last_conversation: {
      description: 'The most recent call with a lead or company, including transcript summary, objections, buying signals, commitments and next steps.',
      schema: {
        type: 'object',
        properties: { lead_id: { type: 'string' }, name_or_company: { type: 'string' } },
      },
      run: ({ lead_id: leadId, name_or_company: nameOrCompany }) => lastConversation({ org, scope, leadId, nameOrCompany }),
    },

    call_list_today: {
      description: 'The ranked list of who this user should call today, with the reason for each.',
      schema: { type: 'object', properties: {} },
      run: () => insights.callListForToday({ organizationId: org, userId: user.id, limit: 12 }),
    },

    deals_at_risk: {
      description: 'Open deals that are at risk, with risk score, reasons and the recommended action.',
      schema: { type: 'object', properties: { limit: { type: 'number' } } },
      run: ({ limit }) => insights.dealsAtRisk({ organizationId: org, ownerIds: scope.ownerIds, limit: limit || 10 }),
    },

    likely_to_convert: {
      description: 'Leads most likely to convert, with the factors behind each score.',
      schema: { type: 'object', properties: { limit: { type: 'number' } } },
      run: ({ limit }) => insights.likelyToConvert({ organizationId: org, ownerIds: scope.ownerIds, limit: limit || 10 }),
    },

    uncontacted_leads: {
      description: 'Leads with no contact in N days, plus leads never contacted at all.',
      schema: { type: 'object', properties: { days: { type: 'number' } } },
      run: ({ days }) => ({
        stale: insights.needsFollowUp({ organizationId: org, ownerIds: scope.ownerIds, days: days || 14, limit: 20 }),
        neverContacted: insights.neverContacted({ organizationId: org, ownerIds: scope.ownerIds, limit: 15 }),
      }),
    },

    objection_trends: {
      description: 'Which objections appear most often across analysed calls, how often they go unhandled, and at which stage.',
      schema: { type: 'object', properties: { since: { type: 'string' } } },
      run: ({ since }) => insights.objectionTrends({ organizationId: org, ownerIds: scope.ownerIds, since, limit: 10 }),
    },

    pipeline_summary: {
      description: 'Pipeline totals by stage, weighted forecast, and what is closing this month.',
      schema: { type: 'object', properties: {} },
      run: () => pipelineSummary({ org, scope }),
    },

    my_day: {
      description: 'Today for this user: calls made, tasks due, meetings, follow-ups pending, pending AI approvals.',
      schema: { type: 'object', properties: {} },
      run: () => myDay({ org, user }),
    },

    win_loss: {
      description: 'Win/loss breakdown with loss reasons and competitors involved.',
      schema: { type: 'object', properties: { since: { type: 'string' } } },
      run: ({ since }) => insights.lossAnalysis({ organizationId: org, ownerIds: scope.ownerIds, since }),
    },
  };

  // Team performance is a manager-and-above capability. An agent asking "who is
  // performing best" gets a refusal from the tool layer, not from the prompt.
  if (isManager) {
    tools.agent_performance = {
      description: 'Per-agent performance for the period: calls, talk time, connect rate, meetings, revenue, quota attainment, average call score.',
      schema: {
        type: 'object',
        properties: { since: { type: 'string' }, until: { type: 'string' } },
      },
      run: ({ since, until }) => insights.agentPerformance({
        organizationId: org,
        since: since || startOfDay(new Date(), -30),
        until: until || endOfDay(),
        teamId: scope.type === 'team' ? user.teamId : null,
      }),
    };
  }

  return tools;
}

// -------------------------------------------------------- tool implementations
function leadFilterClause(scope, alias = 'l') {
  if (scope.type === 'org') return { sql: '', params: [] };
  const ids = scope.ownerIds === 'all' ? [] : scope.ownerIds;
  if (!ids.length) return { sql: ' AND 1 = 0', params: [] };
  const owners = inList(`${alias}.owner_id`, ids);
  return { sql: ` AND ${owners.sql}`, params: owners.params };
}

function resolveLead({ org, scope, leadId, nameOrCompany }) {
  const filter = leadFilterClause(scope);
  if (leadId) {
    return get(`SELECT * FROM leads l WHERE l.id = ? AND l.organization_id = ?${filter.sql}`, [leadId, org, ...filter.params]);
  }
  if (!nameOrCompany) return null;
  const like = `%${nameOrCompany.trim()}%`;
  return get(
    `SELECT * FROM leads l WHERE l.organization_id = ?${filter.sql}
       AND (l.company_name LIKE ? OR l.first_name LIKE ? OR l.last_name LIKE ?
            OR (l.first_name || ' ' || COALESCE(l.last_name,'')) LIKE ?)
     ORDER BY l.updated_at DESC LIMIT 1`,
    [org, ...filter.params, like, like, like, like],
  );
}

function leadProfile({ org, scope, leadId, nameOrCompany }) {
  const lead = resolveLead({ org, scope, leadId, nameOrCompany });
  if (!lead) return { error: 'No matching lead found in the records you can access.' };

  const deal = get(`SELECT * FROM deals WHERE lead_id = ? ORDER BY CASE WHEN stage IN ('won','lost') THEN 1 ELSE 0 END, updated_at DESC LIMIT 1`, [lead.id]);
  const calls = all(
    `SELECT c.id, c.direction, c.status, c.outcome, c.started_at, c.duration_seconds, c.talk_seconds,
            a.summary, a.sentiment, a.objections, a.buying_signals, a.next_steps
     FROM calls c LEFT JOIN call_analyses a ON a.call_id = c.id
     WHERE c.lead_id = ? ORDER BY c.started_at DESC LIMIT 5`,
    [lead.id],
  );
  const tasks = all(`SELECT title, type, priority, due_at, status FROM tasks WHERE lead_id = ? AND status IN ('open','in_progress') ORDER BY due_at ASC LIMIT 8`, [lead.id]);
  const notes = all('SELECT body, created_at FROM notes WHERE lead_id = ? ORDER BY created_at DESC LIMIT 5', [lead.id]);
  const emails = all(`SELECT subject, status, sent_at, template FROM emails WHERE lead_id = ? ORDER BY created_at DESC LIMIT 5`, [lead.id]);
  const meetings = all('SELECT title, starts_at, status FROM meetings WHERE lead_id = ? ORDER BY starts_at DESC LIMIT 5', [lead.id]);

  return {
    lead: {
      id: lead.id,
      name: `${lead.first_name} ${lead.last_name || ''}`.trim(),
      company: lead.company_name,
      jobTitle: lead.job_title,
      email: lead.email,
      phone: lead.phone_e164,
      location: lead.location,
      status: lead.status,
      temperature: lead.temperature,
      score: lead.score,
      source: lead.source,
      tags: parseJson(lead.tags, []),
      lastContactedAt: lead.last_contacted_at,
      nextFollowUpAt: lead.next_follow_up_at,
      doNotCall: Boolean(lead.do_not_call),
    },
    deal: deal ? {
      id: deal.id, name: deal.name, stage: deal.stage, value: deal.value, probability: deal.probability,
      expectedCloseDate: deal.expected_close_date, budget: deal.budget, timeline: deal.timeline,
      decisionMaker: deal.decision_maker, competitors: parseJson(deal.competitors, []),
      painPoints: parseJson(deal.pain_points, []), requirements: parseJson(deal.requirements, []),
    } : null,
    recentCalls: calls.map((c) => ({
      id: c.id, direction: c.direction, outcome: c.outcome, startedAt: c.started_at,
      durationSeconds: c.duration_seconds, summary: c.summary, sentiment: c.sentiment,
      objections: parseJson(c.objections, []).map((o) => `${o.category}: ${o.text}`),
      buyingSignals: parseJson(c.buying_signals, []).map((s) => s.signal),
      nextSteps: parseJson(c.next_steps, []),
    })),
    openTasks: tasks,
    recentEmails: emails,
    meetings,
    notes: notes.map((n) => n.body),
  };
}

function lastConversation({ org, scope, leadId, nameOrCompany }) {
  const lead = resolveLead({ org, scope, leadId, nameOrCompany });
  if (!lead) return { error: 'No matching lead found in the records you can access.' };
  const row = get(
    `SELECT c.*, a.summary, a.key_points, a.objections, a.buying_signals, a.commitments, a.next_steps,
            a.action_items, a.sentiment, a.talk_ratio, t.full_text
     FROM calls c
     LEFT JOIN call_analyses a ON a.call_id = c.id
     LEFT JOIN transcripts t ON t.call_id = c.id
     WHERE c.lead_id = ? AND c.status = 'completed'
     ORDER BY c.started_at DESC LIMIT 1`,
    [lead.id],
  );
  if (!row) return { lead: `${lead.first_name} ${lead.last_name || ''}`.trim(), message: 'No completed calls on record for this contact.' };

  return {
    lead: `${lead.first_name} ${lead.last_name || ''}`.trim(),
    company: lead.company_name,
    callId: row.id,
    date: row.started_at,
    durationSeconds: row.duration_seconds,
    sentiment: row.sentiment,
    talkRatio: row.talk_ratio,
    summary: row.summary,
    keyPoints: parseJson(row.key_points, []),
    objections: parseJson(row.objections, []),
    buyingSignals: parseJson(row.buying_signals, []),
    commitments: parseJson(row.commitments, []),
    nextSteps: parseJson(row.next_steps, []),
    actionItems: parseJson(row.action_items, []),
    transcriptExcerpt: row.full_text ? String(row.full_text).slice(0, 3000) : null,
  };
}

function listLeads({ org, scope, temperature, status, source, not_contacted_days: notContactedDays, limit = 20 }) {
  const filter = leadFilterClause(scope);
  const params = [org, ...filter.params];
  let sql = `SELECT l.id, l.first_name, l.last_name, l.company_name, l.status, l.temperature, l.score,
                    l.source, l.last_contacted_at, l.next_follow_up_at, l.deal_value
             FROM leads l WHERE l.organization_id = ? AND l.archived_at IS NULL${filter.sql}`;
  if (temperature) {
    sql += ' AND l.temperature = ?';
    params.push(temperature);
  }
  if (status) {
    sql += ' AND l.status = ?';
    params.push(status);
  }
  if (source) {
    sql += ' AND l.source = ?';
    params.push(source);
  }
  if (notContactedDays) {
    sql += ' AND (l.last_contacted_at IS NULL OR l.last_contacted_at < ?)';
    params.push(startOfDay(new Date(), -notContactedDays));
  }
  sql += ' ORDER BY l.score DESC, l.updated_at DESC LIMIT ?';
  params.push(Math.min(limit, 50));
  return all(sql, params).map((l) => ({
    id: l.id,
    name: `${l.first_name} ${l.last_name || ''}`.trim(),
    company: l.company_name,
    status: l.status,
    temperature: l.temperature,
    score: l.score,
    source: l.source,
    value: l.deal_value,
    lastContactedAt: l.last_contacted_at,
    nextFollowUpAt: l.next_follow_up_at,
  }));
}

function listDeals({ org, scope, stage, min_value: minValue, closing_before: closingBefore, open_only: openOnly = true, limit = 20 }) {
  const filter = scope.type === 'org' ? { sql: '', params: [] }
    : (() => {
      const owners = inList('d.owner_id', scope.ownerIds === 'all' ? [] : (scope.ownerIds || []));
      return { sql: ` AND ${owners.sql}`, params: owners.params };
    })();
  const params = [org, ...filter.params];
  let sql = `SELECT d.id, d.name, d.stage, d.value, d.probability, d.expected_close_date, d.lead_id,
                    l.company_name, l.first_name, l.last_name, u.name AS owner_name
             FROM deals d LEFT JOIN leads l ON l.id = d.lead_id LEFT JOIN users u ON u.id = d.owner_id
             WHERE d.organization_id = ?${filter.sql}`;
  if (openOnly) sql += ` AND d.stage NOT IN ('won','lost')`;
  if (stage) {
    sql += ' AND d.stage = ?';
    params.push(stage);
  }
  if (minValue) {
    sql += ' AND d.value >= ?';
    params.push(minValue);
  }
  if (closingBefore) {
    sql += ' AND d.expected_close_date <= ?';
    params.push(closingBefore);
  }
  sql += ' ORDER BY d.value DESC LIMIT ?';
  params.push(Math.min(limit, 50));
  return all(sql, params).map((d) => ({
    id: d.id,
    name: d.name,
    leadId: d.lead_id,
    contact: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
    company: d.company_name,
    stage: d.stage,
    value: d.value,
    probability: d.probability,
    weighted: Math.round((d.value || 0) * (d.probability || 0) / 100),
    expectedCloseDate: d.expected_close_date,
    owner: d.owner_name,
  }));
}

function pipelineSummary({ org, scope }) {
  const filter = scope.type === 'org' ? { sql: '', params: [] }
    : (() => {
      const owners = inList('owner_id', scope.ownerIds === 'all' ? [] : (scope.ownerIds || []));
      return { sql: ` AND ${owners.sql}`, params: owners.params };
    })();
  const byStage = all(
    `SELECT stage, COUNT(*) AS deals, COALESCE(SUM(value), 0) AS value,
            COALESCE(SUM(value * probability / 100.0), 0) AS weighted
     FROM deals WHERE organization_id = ? AND stage NOT IN ('won','lost')${filter.sql}
     GROUP BY stage`,
    [org, ...filter.params],
  );
  const closingThisMonth = all(
    `SELECT id, name, value, stage, probability, expected_close_date FROM deals
     WHERE organization_id = ? AND stage NOT IN ('won','lost')
       AND expected_close_date BETWEEN ? AND ?${filter.sql}
     ORDER BY value DESC LIMIT 15`,
    [org, startOfDay(), endOfDay(new Date(), 31), ...filter.params],
  );
  return {
    byStage,
    totalOpenValue: byStage.reduce((sum, s) => sum + s.value, 0),
    weightedForecast: Math.round(byStage.reduce((sum, s) => sum + s.weighted, 0)),
    closingWithin31Days: closingThisMonth,
  };
}

function myDay({ org, user }) {
  const from = startOfDay();
  const to = endOfDay();
  return {
    callsToday: get(`SELECT COUNT(*) AS n FROM calls WHERE organization_id = ? AND agent_id = ? AND started_at BETWEEN ? AND ?`, [org, user.id, from, to])?.n || 0,
    connectedToday: get(`SELECT COUNT(*) AS n FROM calls WHERE organization_id = ? AND agent_id = ? AND outcome IN ${CONNECTED_OUTCOMES_SQL} AND started_at BETWEEN ? AND ?`, [org, user.id, from, to])?.n || 0,
    tasksDueToday: all(`SELECT id, title, type, priority, due_at, lead_id FROM tasks WHERE organization_id = ? AND assignee_id = ? AND status = 'open' AND due_at <= ? ORDER BY due_at ASC LIMIT 20`, [org, user.id, to]),
    meetingsToday: all(`SELECT id, title, starts_at, ends_at, lead_id FROM meetings WHERE organization_id = ? AND organizer_id = ? AND starts_at BETWEEN ? AND ? ORDER BY starts_at ASC`, [org, user.id, from, to]),
    followUpsPending: get(`SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND owner_id = ? AND next_follow_up_at <= ?`, [org, user.id, to])?.n || 0,
    pendingAiApprovals: get(`SELECT COUNT(*) AS n FROM ai_suggestions s WHERE s.organization_id = ? AND s.status = 'pending'`, [org])?.n || 0,
  };
}

// ----------------------------------------------------------- local answerer ---
const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

/**
 * Deterministic intent router used when no model is configured. Matches the
 * question against known intents, runs the same tools, and formats the answer.
 */
function localAnswer({ question, tools, user }) {
  const q = String(question || '').toLowerCase();
  const used = [];
  const call = (name, args = {}) => {
    const tool = tools[name];
    if (!tool) return null;
    used.push(name);
    return tool.run(args);
  };

  if (/\b(who|which).*(call|phone|dial)|call list|call today|should i call\b/.test(q)) {
    const list = call('call_list_today') || [];
    if (!list.length) return { text: 'Nothing is queued for a call today. Your follow-ups are current and there are no untouched new leads.', used };
    const lines = list.slice(0, 8).map((c, i) => `${i + 1}. **${c.name}**${c.company ? ` - ${c.company}` : ''}${c.value ? ` (${money(c.value)})` : ''}\n   ${c.reasons.join(' - ')}`);
    return { text: `You have ${list.length} contacts worth calling today. Start at the top:\n\n${lines.join('\n')}`, used };
  }

  if (/\b(at risk|slipping|going to slip|worried|stalled|stuck)\b/.test(q)) {
    const risky = call('deals_at_risk', { limit: 8 }) || [];
    if (!risky.length) return { text: 'No open deals are currently flagged as at risk. Every active deal has recent contact and a forward-dated next step.', used };
    const lines = risky.map((d) => `- **${d.name}** (${money(d.value)}, ${d.stage.replace('_', ' ')}) - risk ${d.riskScore}/100\n  ${d.reasons.join('; ')}\n  Recommended: ${d.recommendedAction}`);
    return { text: `${risky.length} deal${risky.length === 1 ? '' : 's'} need attention:\n\n${lines.join('\n')}`, used };
  }

  if (/\b(likely to (convert|close)|best leads|most promising|hottest)\b/.test(q)) {
    const leads = call('likely_to_convert', { limit: 8 }) || [];
    if (!leads.length) return { text: 'There are no active leads to rank yet.', used };
    const lines = leads.map((l) => `- **${l.name}**${l.company ? ` (${l.company})` : ''} - ${l.likelihood}% likely${l.value ? `, ${money(l.value)}` : ''}\n  ${l.factors.map((f) => `${f.label} ${f.points > 0 ? '+' : ''}${f.points}`).join(', ')}`);
    return { text: `Ranked by conversion likelihood:\n\n${lines.join('\n')}`, used };
  }

  if (/\b(not been contacted|haven'?t been contacted|no contact|uncontacted|gone quiet|neglected)\b/.test(q) || /\b\d+ days\b.*contact/.test(q)) {
    const days = Number((q.match(/\b(\d+)\s*days?\b/) || [])[1]) || 14;
    const result = call('uncontacted_leads', { days }) || { stale: [], neverContacted: [] };
    const parts = [];
    if (result.neverContacted.length) {
      parts.push(`**Never contacted (${result.neverContacted.length})**\n${result.neverContacted.slice(0, 8).map((l) => `- ${l.name}${l.company ? ` - ${l.company}` : ''} (${l.ageHours}h old, score ${l.score})`).join('\n')}`);
    }
    if (result.stale.length) {
      parts.push(`**No contact in ${days}+ days (${result.stale.length})**\n${result.stale.slice(0, 8).map((l) => `- ${l.name}${l.company ? ` - ${l.company}` : ''} - ${l.daysSinceContact ?? 'never'} days, ${l.temperature}`).join('\n')}`);
    }
    return { text: parts.length ? parts.join('\n\n') : `Every lead has been contacted within the last ${days} days.`, used };
  }

  if (/\b(objection|objections|push ?back|concerns)\b/.test(q)) {
    const trends = call('objection_trends') || { objections: [] };
    if (!trends.objections?.length) return { text: 'No objections have been detected in analysed calls yet.', used };
    const lines = trends.objections.map((o) => `- **${o.category.replace('_', ' ')}** - ${o.count} call${o.count === 1 ? '' : 's'} (${o.shareOfCalls}% of calls), ${o.unhandledRate}% left unhandled${o.commonStage ? `, most often at ${o.commonStage.replace('_', ' ')}` : ''}`);
    return { text: `Across ${trends.totalCallsAnalysed} analysed calls:\n\n${lines.join('\n')}\n\nThe unhandled rate is the number to work on - that is coaching, not product.`, used };
  }

  if (/\b(summar|last (call|conversation)|what did .* say|recap)\b/.test(q)) {
    const nameMatch = question.match(/(?:with|for|about|from)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/);
    const conversation = call('last_conversation', { name_or_company: nameMatch?.[1] });
    if (!conversation || conversation.error) {
      return { text: conversation?.error || 'Tell me which contact or company you mean and I will pull up the last conversation.', used };
    }
    if (conversation.message) return { text: `${conversation.lead}: ${conversation.message}`, used };
    const parts = [
      `**${conversation.lead}${conversation.company ? ` - ${conversation.company}` : ''}** - ${new Date(conversation.date).toLocaleDateString()}, ${Math.round(conversation.durationSeconds / 60)} min, sentiment ${conversation.sentiment}`,
      conversation.summary,
    ];
    if (conversation.objections?.length) parts.push(`**Objections:** ${conversation.objections.map((o) => `${o.category} - ${o.text}`).join(' | ')}`);
    if (conversation.buyingSignals?.length) parts.push(`**Buying signals:** ${conversation.buyingSignals.map((s) => s.signal).join(', ')}`);
    if (conversation.nextSteps?.length) parts.push(`**Next steps:** ${conversation.nextSteps.join('; ')}`);
    return { text: parts.filter(Boolean).join('\n\n'), used };
  }

  if (/\b(pipeline|forecast|close this month|closing this month|revenue)\b/.test(q)) {
    const summary = call('pipeline_summary') || { byStage: [] };
    const lines = summary.byStage.map((s) => `- ${s.stage.replace('_', ' ')}: ${s.deals} deal${s.deals === 1 ? '' : 's'}, ${money(s.value)} (${money(s.weighted)} weighted)`);
    const closing = summary.closingWithin31Days?.slice(0, 6).map((d) => `- ${d.name} - ${money(d.value)} at ${d.probability}% (${String(d.expected_close_date).slice(0, 10)})`) || [];
    return {
      text: `Open pipeline is ${money(summary.totalOpenValue)} with a weighted forecast of ${money(summary.weightedForecast)}.\n\n${lines.join('\n')}${closing.length ? `\n\n**Closing within 31 days**\n${closing.join('\n')}` : ''}`,
      used,
    };
  }

  if (/\b(performing|performance|leaderboard|best agent|team)\b/.test(q)) {
    const performance = call('agent_performance', {});
    if (!performance) return { text: 'Team performance is only available to managers and administrators.', used };
    const lines = performance.slice(0, 8).map((a) => `- **${a.name}** - ${money(a.revenue)} closed, ${a.calls} calls, ${a.connectRate}% connect, ${a.talkMinutes}m talk${a.avgCallScore ? `, call score ${a.avgCallScore}` : ''}${a.quotaAttainment !== null ? `, ${a.quotaAttainment}% of quota` : ''}`);
    return { text: `Last 30 days:\n\n${lines.join('\n')}`, used };
  }

  if (/\b(why.*los|lost|loss|win rate|win\/loss)\b/.test(q)) {
    const analysis = call('win_loss') || {};
    const lines = (analysis.reasons || []).slice(0, 6).map((r) => `- **${r.reason}** - ${r.count} deal${r.count === 1 ? '' : 's'}, ${money(r.value)}${r.competitors.length ? ` (lost to ${r.competitors.join(', ')})` : ''}${r.lostMostAtStage ? `, usually at ${r.lostMostAtStage.replace('_', ' ')}` : ''}`);
    return {
      text: `Win rate is ${analysis.winRate}% (${analysis.wonCount} won / ${analysis.lostCount} lost, ${money(analysis.lostValue)} lost value).\n\n${lines.join('\n') || 'No loss reasons recorded yet.'}`,
      used,
    };
  }

  if (/\b(my day|today|what should i do|priorit)/.test(q)) {
    const day = call('my_day') || {};
    const list = call('call_list_today') || [];
    return {
      text: [
        `**Today so far:** ${day.callsToday} calls (${day.connectedToday} connected), ${day.tasksDueToday?.length || 0} tasks due, ${day.meetingsToday?.length || 0} meetings, ${day.followUpsPending} follow-ups pending.`,
        day.pendingAiApprovals ? `${day.pendingAiApprovals} AI suggestion${day.pendingAiApprovals === 1 ? '' : 's'} waiting for your approval.` : null,
        list.length ? `**Start with:** ${list.slice(0, 3).map((c) => `${c.name}${c.company ? ` (${c.company})` : ''}`).join(', ')}` : null,
      ].filter(Boolean).join('\n\n'),
      used,
    };
  }

  // Fall back to search so an unrecognised question still returns something useful.
  const { filters, results } = searchService.naturalSearch({
    organizationId: user.organizationId,
    query: question,
    scope: scopeFor(user),
    userId: user.id,
    limit: 12,
  });
  used.push('search_crm');
  if (!results.length) {
    return {
      text: 'I could not find anything matching that. Try naming a contact, company, or one of: who should I call today, deals at risk, leads not contacted in 14 days, most common objections, pipeline forecast.',
      used,
    };
  }
  const lines = results.slice(0, 10).map((r) => `- **${r.entityLabel}**: ${r.title}${r.excerpt ? ` - ${r.excerpt.replace(/\s+/g, ' ')}` : ''}`);
  return {
    text: `${results.length} match${results.length === 1 ? '' : 'es'}${filters.since ? ' in that period' : ''}:\n\n${lines.join('\n')}`,
    used,
  };
}

// --------------------------------------------------------------------- ask ---
export async function ask({ user, question, conversationId = null, history = [] }) {
  const tools = buildTools(user);
  const started = Date.now();
  let answer;
  let provider = 'local';
  let usage = { inputTokens: 0, outputTokens: 0 };
  let toolsUsed = [];

  const useModel = config.ai.provider !== 'local' && anthropic.isConfigured();

  if (useModel) {
    try {
      const { ASSISTANT_SYSTEM } = await import('./prompts.js');
      const toolDefinitions = Object.entries(tools).map(([name, tool]) => ({
        name,
        description: tool.description,
        input_schema: tool.schema,
      }));
      const toolHandlers = Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [name, async (args) => tool.run(args || {})]),
      );
      const messages = [
        ...history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: question },
      ];
      const result = await anthropic.toolLoop({
        system: `${ASSISTANT_SYSTEM}\n\nThe current user is ${user.name}, role ${user.role}. Today is ${new Date().toISOString().slice(0, 10)}.`,
        messages,
        tools: toolDefinitions,
        toolHandlers,
        maxTurns: 5,
      });
      answer = result.text;
      usage = result.usage;
      toolsUsed = result.trace.map((t) => t.tool);
      provider = 'anthropic';
    } catch (error) {
      logger.warn('assistant model call failed, falling back to local engine', { error: error.message });
      const local = localAnswer({ question, tools, user });
      answer = local.text;
      toolsUsed = local.used;
      provider = 'local-fallback';
    }
  } else {
    const local = localAnswer({ question, tools, user });
    answer = local.text;
    toolsUsed = local.used;
  }

  insert('ai_usage', {
    id: id('aiu'),
    organization_id: user.organizationId,
    user_id: user.id,
    feature: 'assistant',
    provider,
    model: provider.startsWith('anthropic') ? config.ai.anthropic.model : 'local-router',
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    latency_ms: Date.now() - started,
    success: 1,
    created_at: nowIso(),
  });

  const conversation = persistConversation({ user, conversationId, question, answer });

  return {
    answer,
    provider,
    toolsUsed: [...new Set(toolsUsed)],
    conversationId: conversation.id,
    latencyMs: Date.now() - started,
    availableTools: Object.keys(tools),
  };
}

function persistConversation({ user, conversationId, question, answer }) {
  const existing = conversationId
    ? get('SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?', [conversationId, user.id])
    : null;
  const messages = existing ? parseJson(existing.messages, []) : [];
  messages.push({ role: 'user', content: question, at: nowIso() });
  messages.push({ role: 'assistant', content: answer, at: nowIso() });
  // Keep the tail only: older turns add tokens without adding accuracy.
  const trimmed = messages.slice(-40);

  if (existing) {
    run('UPDATE ai_conversations SET messages = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(trimmed), nowIso(), existing.id]);
    return existing;
  }
  const row = {
    id: id('aic'),
    organization_id: user.organizationId,
    user_id: user.id,
    title: question.slice(0, 80),
    messages: JSON.stringify(trimmed),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('ai_conversations', row);
  return row;
}

export function conversations(userId, limit = 20) {
  return all('SELECT id, title, created_at, updated_at FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?', [userId, limit]);
}

export function conversation(userId, conversationId) {
  const row = get('SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?', [conversationId, userId]);
  return row ? { ...row, messages: parseJson(row.messages, []) } : null;
}

export default { ask, scopeFor, conversations, conversation };
