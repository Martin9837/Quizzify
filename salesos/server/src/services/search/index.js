import { all, run, inList } from '../../db/index.js';
import { startOfDay } from '../../lib/time.js';
import logger from '../../lib/logger.js';
import { LEAD_TEMPERATURES, LEAD_STATUSES, OBJECTION_CATEGORIES, STAGE_KEYS } from '../../lib/constants.js';

/**
 * Search/indexing layer built on SQLite FTS5.
 *
 * Every searchable record is projected into `search_index` with a title, a body
 * and the metadata needed for permission filtering (organisation, owner, lead).
 * `parseNaturalQuery` turns a sentence such as
 *   "hot leads I spoke with last week who mentioned pricing concerns"
 * into structured filters plus the residual free-text terms.
 */

const ENTITY_LABELS = {
  lead: 'Lead',
  company: 'Company',
  deal: 'Deal',
  call: 'Call',
  transcript: 'Transcript',
  email: 'Email',
  task: 'Task',
  note: 'Note',
  meeting: 'Meeting',
};

export function indexRecord({ organizationId, entityType, entityId, ownerId, leadId, occurredAt, title, body }) {
  removeFromIndex(entityType, entityId);
  run(
    `INSERT INTO search_index (organization_id, entity_type, entity_id, owner_id, lead_id, occurred_at, title, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [organizationId, entityType, entityId, ownerId || null, leadId || null, occurredAt || new Date().toISOString(), title || '', body || ''],
  );
}

export function removeFromIndex(entityType, entityId) {
  run('DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?', [entityType, entityId]);
}

/** FTS5 MATCH syntax is strict; quote every term and drop operators. */
function toMatchExpression(text) {
  const terms = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s@.'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'who', 'that', 'this', 'from', 'have', 'has',
  'was', 'were', 'are', 'all', 'any', 'about', 'show', 'find', 'give', 'list',
  'get', 'his', 'her', 'they', 'them', 'their', 'our', 'you', 'your', 'need',
  'want', 'please', 'which', 'what', 'when', 'where', 'how', 'why', 'did',
]);

/**
 * Structured search. `scope` restricts visibility:
 *   { type: 'own', userId } | { type: 'team', userIds } | { type: 'org' }
 */
export function search({ organizationId, query, entityTypes, scope, since, until, limit = 40 }) {
  const match = toMatchExpression(query);
  const params = [organizationId];
  let sql = `SELECT entity_type, entity_id, owner_id, lead_id, occurred_at, title,
                    snippet(search_index, 7, '[', ']', '...', 18) AS excerpt,
                    bm25(search_index) AS rank
             FROM search_index WHERE organization_id = ?`;

  if (match) {
    sql += ' AND search_index MATCH ?';
    params.push(match);
  }
  if (entityTypes?.length) {
    const types = inList('entity_type', entityTypes);
    sql += ` AND ${types.sql}`;
    params.push(...types.params);
  }
  if (scope?.type === 'own') {
    sql += ' AND (owner_id = ? OR owner_id IS NULL)';
    params.push(scope.userId);
  } else if (scope?.type === 'team' && scope.userIds?.length) {
    const owners = inList('owner_id', scope.userIds);
    sql += ` AND (${owners.sql} OR owner_id IS NULL)`;
    params.push(...owners.params);
  }
  if (since) {
    sql += ' AND occurred_at >= ?';
    params.push(since);
  }
  if (until) {
    sql += ' AND occurred_at <= ?';
    params.push(until);
  }
  sql += match ? ' ORDER BY rank LIMIT ?' : ' ORDER BY occurred_at DESC LIMIT ?';
  params.push(limit);

  try {
    return all(sql, params).map((row) => ({
      entityType: row.entity_type,
      entityLabel: ENTITY_LABELS[row.entity_type] || row.entity_type,
      entityId: row.entity_id,
      leadId: row.lead_id,
      ownerId: row.owner_id,
      occurredAt: row.occurred_at,
      title: row.title,
      excerpt: row.excerpt,
      score: row.rank === null ? 0 : Math.round(Math.abs(row.rank) * 100) / 100,
    }));
  } catch (error) {
    logger.warn('search failed', { error: error.message, query });
    return [];
  }
}

// ------------------------------------------------- natural language parse ---
const RELATIVE_RANGES = [
  { re: /\btoday\b/, days: 0 },
  { re: /\byesterday\b/, days: 1 },
  { re: /\bthis week\b/, days: 7 },
  { re: /\blast week\b/, days: 14 },
  { re: /\blast (\d+) days\b/, dynamic: true },
  { re: /\bthis month\b/, days: 30 },
  { re: /\blast month\b/, days: 60 },
  { re: /\blast quarter\b/, days: 120 },
];

/**
 * Extract filters from a sentence. Everything not consumed by a filter is
 * returned as `terms` and handed to FTS.
 */
export function parseNaturalQuery(input, { userId } = {}) {
  const text = String(input || '').toLowerCase();
  const filters = { entityTypes: [], temperature: null, status: null, stage: null, since: null, ownerId: null, topics: [] };
  let residual = text;

  const consume = (re) => {
    residual = residual.replace(re, ' ');
  };

  for (const temp of LEAD_TEMPERATURES) {
    if (new RegExp(`\\b${temp}\\b`).test(text)) {
      filters.temperature = temp;
      consume(new RegExp(`\\b${temp}\\b`, 'g'));
    }
  }
  for (const status of LEAD_STATUSES) {
    if (new RegExp(`\\b${status}\\b`).test(text)) filters.status = status;
  }
  for (const stage of STAGE_KEYS) {
    const label = stage.replace('_', ' ');
    if (new RegExp(`\\b${label}\\b`).test(text)) filters.stage = stage;
  }
  for (const topic of OBJECTION_CATEGORIES) {
    if (new RegExp(`\\b${topic.replace('_', ' ')}\\b`).test(text)) filters.topics.push(topic);
  }

  if (/\b(my|i|mine|me)\b/.test(text) && userId) {
    filters.ownerId = userId;
    consume(/\b(my|i|mine|me)\b/g);
  }

  for (const range of RELATIVE_RANGES) {
    const m = text.match(range.re);
    if (!m) continue;
    const days = range.dynamic ? Number.parseInt(m[1], 10) : range.days;
    filters.since = startOfDay(new Date(), -Math.abs(days || 0));
    consume(range.re);
    break;
  }

  const typeHints = [
    [/\b(lead|leads|prospect|prospects|contact|contacts)\b/, 'lead'],
    [/\b(deal|deals|opportunit\w+|pipeline)\b/, 'deal'],
    [/\b(call|calls|conversation|conversations|spoke|talked|called)\b/, ['call', 'transcript']],
    [/\b(transcript|transcripts|said|mentioned)\b/, 'transcript'],
    [/\b(email|emails|mail)\b/, 'email'],
    [/\b(task|tasks|todo|follow.?up)\b/, 'task'],
    [/\b(meeting|meetings|demo|demos)\b/, 'meeting'],
    [/\b(note|notes)\b/, 'note'],
    [/\b(company|companies|account|accounts)\b/, 'company'],
  ];
  for (const [re, type] of typeHints) {
    if (re.test(text)) {
      const types = Array.isArray(type) ? type : [type];
      for (const t of types) if (!filters.entityTypes.includes(t)) filters.entityTypes.push(t);
      consume(new RegExp(re.source, 'g'));
    }
  }

  filters.terms = residual.replace(/\s+/g, ' ').trim();
  return filters;
}

/** Full-text search driven by a natural-language sentence. */
export function naturalSearch({ organizationId, query, scope, userId, limit = 40 }) {
  const filters = parseNaturalQuery(query, { userId });
  const searchText = [filters.terms, ...filters.topics].filter(Boolean).join(' ');
  const results = search({
    organizationId,
    query: searchText || query,
    entityTypes: filters.entityTypes.length ? filters.entityTypes : undefined,
    scope: filters.ownerId ? { type: 'own', userId: filters.ownerId } : scope,
    since: filters.since,
    limit,
  });
  return { filters, results };
}

/** Rebuild the whole index. Used by the seeder and the admin re-index action. */
export function reindexOrganization(organizationId) {
  run('DELETE FROM search_index WHERE organization_id = ?', [organizationId]);
  let count = 0;

  for (const lead of all('SELECT * FROM leads WHERE organization_id = ?', [organizationId])) {
    indexRecord({
      organizationId,
      entityType: 'lead',
      entityId: lead.id,
      ownerId: lead.owner_id,
      leadId: lead.id,
      occurredAt: lead.updated_at,
      title: `${lead.first_name} ${lead.last_name || ''} - ${lead.company_name || ''}`.trim(),
      body: [lead.email, lead.phone, lead.job_title, lead.industry, lead.location, lead.status,
        lead.temperature, lead.source, (JSON.parse(lead.tags || '[]') || []).join(' ')].filter(Boolean).join(' '),
    });
    count += 1;
  }
  for (const company of all('SELECT * FROM companies WHERE organization_id = ?', [organizationId])) {
    indexRecord({
      organizationId, entityType: 'company', entityId: company.id, occurredAt: company.updated_at,
      title: company.name, body: [company.domain, company.industry, company.location, company.notes].filter(Boolean).join(' '),
    });
    count += 1;
  }
  for (const deal of all('SELECT * FROM deals WHERE organization_id = ?', [organizationId])) {
    indexRecord({
      organizationId, entityType: 'deal', entityId: deal.id, ownerId: deal.owner_id, leadId: deal.lead_id,
      occurredAt: deal.updated_at, title: deal.name,
      body: [deal.stage, deal.product, deal.decision_maker, deal.timeline, deal.lost_reason,
        deal.competitors, deal.pain_points, deal.requirements].filter(Boolean).join(' '),
    });
    count += 1;
  }
  for (const call of all('SELECT * FROM calls WHERE organization_id = ?', [organizationId])) {
    indexRecord({
      organizationId, entityType: 'call', entityId: call.id, ownerId: call.agent_id, leadId: call.lead_id,
      occurredAt: call.started_at || call.created_at,
      title: `${call.direction} call - ${call.status}`,
      body: [call.notes, call.outcome, call.disposition_note, call.to_number].filter(Boolean).join(' '),
    });
    count += 1;
  }
  for (const t of all(`SELECT t.*, c.agent_id FROM transcripts t JOIN calls c ON c.id = t.call_id
                       WHERE t.organization_id = ?`, [organizationId])) {
    indexRecord({
      organizationId, entityType: 'transcript', entityId: t.id, ownerId: t.agent_id, leadId: t.lead_id,
      occurredAt: t.created_at, title: 'Call transcript', body: t.full_text,
    });
    count += 1;
  }
  for (const email of all('SELECT * FROM emails WHERE organization_id = ?', [organizationId])) {
    indexRecord({
      organizationId, entityType: 'email', entityId: email.id, ownerId: email.user_id, leadId: email.lead_id,
      occurredAt: email.sent_at || email.created_at, title: email.subject || '(no subject)', body: email.body,
    });
    count += 1;
  }
  for (const task of all('SELECT * FROM tasks WHERE organization_id = ?', [organizationId])) {
    indexRecord({
      organizationId, entityType: 'task', entityId: task.id, ownerId: task.assignee_id, leadId: task.lead_id,
      occurredAt: task.due_at || task.created_at, title: task.title, body: [task.description, task.ai_reason].filter(Boolean).join(' '),
    });
    count += 1;
  }
  for (const note of all('SELECT * FROM notes WHERE organization_id = ?', [organizationId])) {
    indexRecord({
      organizationId, entityType: 'note', entityId: note.id, ownerId: note.author_id, leadId: note.lead_id,
      occurredAt: note.created_at, title: 'Note', body: note.body,
    });
    count += 1;
  }
  for (const meeting of all('SELECT * FROM meetings WHERE organization_id = ?', [organizationId])) {
    indexRecord({
      organizationId, entityType: 'meeting', entityId: meeting.id, ownerId: meeting.organizer_id, leadId: meeting.lead_id,
      occurredAt: meeting.starts_at, title: meeting.title, body: [meeting.description, meeting.location, meeting.outcome_notes].filter(Boolean).join(' '),
    });
    count += 1;
  }

  logger.info('search index rebuilt', { organizationId, records: count });
  return count;
}

export default { indexRecord, removeFromIndex, search, naturalSearch, parseNaturalQuery, reindexOrganization };
