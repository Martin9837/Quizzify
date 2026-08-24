import { get, all, insert, run, transaction, parseJson } from '../../db/index.js';
import { id } from '../../lib/ids.js';
import { nowIso, toIso } from '../../lib/time.js';
import { AI_FIELD_MAP, STAGE_MAP, LEAD_TEMPERATURES, STAGE_KEYS } from '../../lib/constants.js';
import { orgSettings } from '../org.js';
import * as audit from '../audit.js';
import * as activity from '../activity.js';
import * as webhooks from '../webhooks.js';
import { emitToUser } from '../realtime/index.js';
import { indexRecord } from '../search/index.js';
import logger from '../../lib/logger.js';
import { notFound, badRequest, forbidden } from '../../lib/errors.js';

/**
 * Transcript -> CRM. Three stages, deliberately separated:
 *
 *   1. `buildSuggestions`  turn an analysis into candidate field changes
 *   2. `persistSuggestions` store them, auto-applying only what policy allows
 *   3. `decide`            apply/reject a suggestion on a human's instruction
 *
 * The split is what makes "AI reduces work without taking control" real: the
 * organisation's approval policy decides which changes need a human, and every
 * applied change -- automatic or approved -- lands in the audit trail with the
 * transcript evidence that produced it.
 */

const normalise = (value) => (value === undefined ? null : value);

function currentValue(entity, field) {
  const raw = entity?.[field];
  if (raw === undefined || raw === null) return null;
  if (['tags', 'competitors', 'pain_points', 'requirements'].includes(field)) return parseJson(raw, []);
  return raw;
}

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const sa = (Array.isArray(a) ? a : []).map(String).sort();
    const sb = (Array.isArray(b) ? b : []).map(String).sort();
    return JSON.stringify(sa) === JSON.stringify(sb);
  }
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (a === null || b === null) return a === b;
  return String(a).trim() === String(b).trim();
}

/** Map the analysis `extraction` block onto concrete field changes. */
export function buildSuggestions({ analysis, lead, deal, callDate = nowIso() }) {
  const extraction = analysis?.extraction || {};
  const confidences = analysis?.field_confidence || {};
  const candidates = [];

  const propose = ({ entity, field, value, confidence, rationale, evidence = [] }) => {
    if (value === null || value === undefined || value === '') return;
    const key = `${entity}.${field}`;
    const definition = AI_FIELD_MAP[key];
    if (!definition) return;
    if (definition.options && !definition.options.includes(value)) return;

    const target = entity === 'lead' ? lead : deal;
    if (!target) return;
    const existing = currentValue(target, field);
    if (sameValue(existing, value)) return;

    candidates.push({
      entityType: entity,
      entityId: target.id,
      field,
      label: definition.label,
      valueType: definition.type,
      sensitivity: definition.sensitive ? 'sensitive' : 'normal',
      currentValue: existing,
      suggestedValue: value,
      confidence: Math.max(0, Math.min(1, confidence ?? 0.6)),
      rationale,
      evidence: evidence.filter(Boolean).slice(0, 3),
    });
  };

  const quote = (text) => (text ? [String(text).slice(0, 300)] : []);

  // ---- lead fields --------------------------------------------------------
  if (extraction.lead_temperature && LEAD_TEMPERATURES.includes(extraction.lead_temperature)) {
    propose({
      entity: 'lead',
      field: 'temperature',
      value: extraction.lead_temperature,
      confidence: confidences.lead_temperature ?? 0.75,
      rationale: `Customer interest read as ${extraction.customer_interest || 'unclear'} with ${analysis.buying_signals?.length || 0} buying signal(s) and ${analysis.objections?.length || 0} objection(s).`,
      evidence: quote(analysis.buying_signals?.[0]?.evidence),
    });
  }
  if (extraction.follow_up_date) {
    const iso = toIso(extraction.follow_up_date);
    if (iso) {
      propose({
        entity: 'lead',
        field: 'next_follow_up_at',
        value: iso,
        confidence: confidences.follow_up_date ?? 0.7,
        rationale: extraction.timeline ? `Customer indicated a ${extraction.timeline} timeline.` : 'Derived from the agreed next step.',
        evidence: quote(analysis.next_steps?.[0]),
      });
    }
  }
  if (extraction.job_title) {
    propose({ entity: 'lead', field: 'job_title', value: extraction.job_title, confidence: confidences.job_title ?? 0.7, rationale: 'Stated on the call.' });
  }
  if (analysis.topics?.length && lead) {
    const existingTags = currentValue(lead, 'tags') || [];
    const merged = [...new Set([...existingTags, ...analysis.topics.slice(0, 3)])];
    propose({
      entity: 'lead',
      field: 'tags',
      value: merged,
      confidence: 0.65,
      rationale: `Conversation topics: ${analysis.topics.slice(0, 3).join(', ')}.`,
    });
  }
  const leadScore = scoreLead({ analysis, lead });
  if (leadScore !== null) {
    propose({
      entity: 'lead',
      field: 'score',
      value: leadScore,
      confidence: 0.72,
      rationale: 'Recomputed from buying signals, objections, budget clarity and engagement on this call.',
    });
  }

  // ---- deal fields --------------------------------------------------------
  if (extraction.deal_stage && STAGE_KEYS.includes(extraction.deal_stage)) {
    propose({
      entity: 'deal',
      field: 'stage',
      value: extraction.deal_stage,
      confidence: confidences.deal_stage ?? 0.7,
      rationale: `Conversation content matches the ${STAGE_MAP[extraction.deal_stage]?.label || extraction.deal_stage} stage.`,
      evidence: quote(analysis.next_steps?.[0] || analysis.summary),
    });
    const probability = STAGE_MAP[extraction.deal_stage]?.probability;
    if (probability !== undefined) {
      propose({
        entity: 'deal',
        field: 'probability',
        value: probability,
        confidence: (confidences.deal_stage ?? 0.7) * 0.9,
        rationale: `Standard probability for the ${STAGE_MAP[extraction.deal_stage].label} stage.`,
      });
    }
  }
  if (extraction.budget) {
    propose({
      entity: 'deal',
      field: 'budget',
      value: Number(extraction.budget),
      confidence: confidences.budget ?? 0.8,
      rationale: 'Budget figure stated by the customer.',
      evidence: quote(extraction.budget_evidence),
    });
  }
  if (extraction.expected_value) {
    propose({
      entity: 'deal',
      field: 'value',
      value: Number(extraction.expected_value),
      confidence: confidences.expected_value ?? 0.65,
      rationale: 'Expected value derived from the scope and budget discussed.',
      evidence: quote(extraction.budget_evidence),
    });
  }
  if (extraction.timeline) {
    propose({ entity: 'deal', field: 'timeline', value: extraction.timeline, confidence: confidences.timeline ?? 0.78, rationale: 'Timeline stated by the customer.' });
  }
  if (extraction.decision_maker) {
    propose({ entity: 'deal', field: 'decision_maker', value: extraction.decision_maker, confidence: confidences.decision_maker ?? 0.8, rationale: 'Named as the approver on the call.' });
  }
  if (extraction.product_discussed) {
    propose({ entity: 'deal', field: 'product', value: extraction.product_discussed, confidence: 0.7, rationale: 'Product discussed during the call.' });
  }
  const competitors = extraction.competitors || analysis.competitors || [];
  if (competitors.length && deal) {
    const merged = [...new Set([...(currentValue(deal, 'competitors') || []), ...competitors])];
    propose({ entity: 'deal', field: 'competitors', value: merged, confidence: confidences.competitors ?? 0.85, rationale: `Competitor(s) named: ${competitors.join(', ')}.` });
  }
  if (extraction.pain_points?.length && deal) {
    const merged = [...new Set([...(currentValue(deal, 'pain_points') || []), ...extraction.pain_points])].slice(0, 8);
    propose({ entity: 'deal', field: 'pain_points', value: merged, confidence: confidences.pain_points ?? 0.7, rationale: 'Pain points described by the customer.' });
  }
  if (extraction.requirements?.length && deal) {
    const merged = [...new Set([...(currentValue(deal, 'requirements') || []), ...extraction.requirements])].slice(0, 10);
    propose({ entity: 'deal', field: 'requirements', value: merged, confidence: confidences.requirements ?? 0.72, rationale: 'Requirements stated as necessary to proceed.' });
  }
  if (extraction.timeline && deal) {
    const closeDate = estimateCloseDate(extraction.timeline, callDate);
    if (closeDate) {
      propose({
        entity: 'deal',
        field: 'expected_close_date',
        value: closeDate,
        confidence: (confidences.timeline ?? 0.75) * 0.85,
        rationale: `Projected from the stated ${extraction.timeline} timeline.`,
      });
    }
  }
  if (extraction.lost_reason) {
    propose({ entity: 'deal', field: 'lost_reason', value: extraction.lost_reason, confidence: 0.6, rationale: 'Signal that the opportunity may be lost.' });
  }

  return candidates;
}

/** 0-100 lead score. Deterministic, explainable, and recomputed per call. */
export function scoreLead({ analysis, lead }) {
  if (!analysis) return null;
  let score = 30;
  const strong = (analysis.buying_signals || []).filter((s) => s.strength === 'strong').length;
  const moderate = (analysis.buying_signals || []).filter((s) => s.strength === 'moderate').length;
  score += strong * 12 + moderate * 6;
  score += (analysis.extraction?.budget ? 12 : 0);
  score += (analysis.extraction?.decision_maker ? 8 : 0);
  score += (analysis.extraction?.timeline ? 8 : 0);
  score -= (analysis.objections || []).filter((o) => o.severity === 'high' && !o.handled).length * 12;
  score -= (analysis.risks || []).length * 3;
  if (analysis.sentiment === 'positive') score += 6;
  if (analysis.sentiment === 'negative') score -= 10;
  if (lead?.source === 'referral' || lead?.source === 'inbound_form') score += 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function estimateCloseDate(timelineLabel, from) {
  const base = new Date(from);
  const weeks = String(timelineLabel).match(/(\d+)\s*weeks?/i);
  const days = weeks ? Number(weeks[1]) * 7
    : /this week/i.test(timelineLabel) ? 5
      : /next week/i.test(timelineLabel) ? 10
        : /this quarter/i.test(timelineLabel) ? 45
          : /next month/i.test(timelineLabel) ? 35
            : /next quarter/i.test(timelineLabel) ? 120
              : /next fiscal|next year/i.test(timelineLabel) ? 240 : null;
  if (!days) return null;
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString();
}

// ------------------------------------------------------------- persistence ---
/**
 * Store suggestions. Anything the policy allows to bypass review is applied
 * immediately and marked `auto_applied`; the rest waits for a decision.
 */
export function persistSuggestions({ organizationId, sourceType, sourceId, candidates, actorId = null, notifyUserId = null }) {
  if (!candidates?.length) return { batchId: null, suggestions: [], autoApplied: 0 };
  const settings = orgSettings(organizationId);
  const policy = settings.crmApproval || {};
  const batchId = id('sgb');
  const stored = [];
  let autoApplied = 0;

  transaction(() => {
    for (const candidate of candidates) {
      const canAuto = policy.mode === 'auto'
        && candidate.confidence >= (policy.autoApplyConfidenceThreshold ?? 0.85)
        && !(policy.alwaysReviewSensitive !== false && candidate.sensitivity === 'sensitive');

      const row = {
        id: id('sug'),
        organization_id: organizationId,
        batch_id: batchId,
        source_type: sourceType,
        source_id: sourceId,
        entity_type: candidate.entityType,
        entity_id: candidate.entityId,
        field: candidate.field,
        label: candidate.label,
        current_value: JSON.stringify(normalise(candidate.currentValue)),
        suggested_value: JSON.stringify(normalise(candidate.suggestedValue)),
        value_type: candidate.valueType,
        confidence: candidate.confidence,
        sensitivity: candidate.sensitivity,
        rationale: candidate.rationale || null,
        evidence: JSON.stringify(candidate.evidence || []),
        status: 'pending',
        created_at: nowIso(),
      };
      insert('ai_suggestions', row);

      // Supersede any earlier pending suggestion for the same field so the
      // review panel never shows two competing values.
      run(
        `UPDATE ai_suggestions SET status = 'superseded'
         WHERE organization_id = ? AND entity_type = ? AND entity_id = ? AND field = ?
           AND status = 'pending' AND id != ?`,
        [organizationId, candidate.entityType, candidate.entityId, candidate.field, row.id],
      );

      if (canAuto) {
        applyValue({
          organizationId,
          suggestion: row,
          value: candidate.suggestedValue,
          actorId,
          actorType: 'ai',
          status: 'auto_applied',
        });
        autoApplied += 1;
      }
      stored.push(row);
    }
  });

  const pending = stored.filter((s) => s.status === 'pending').length;
  if (pending && notifyUserId) {
    emitToUser(notifyUserId, 'ai.suggestions.ready', { batchId, sourceType, sourceId, pending, autoApplied });
  }
  webhooks.dispatch(organizationId, 'ai.suggestions.ready', { batchId, sourceType, sourceId, pending, autoApplied });
  logger.info('ai suggestions stored', { batchId, count: stored.length, autoApplied, pending });

  return { batchId, suggestions: stored.map(toView), autoApplied, pending };
}

// ------------------------------------------------------------- application ---
const LEAD_TABLE_FIELDS = new Set(['temperature', 'status', 'score', 'next_follow_up_at', 'job_title', 'industry', 'email', 'tags', 'deal_value', 'expected_close_date']);
const DEAL_TABLE_FIELDS = new Set(['stage', 'value', 'budget', 'probability', 'expected_close_date', 'timeline', 'decision_maker', 'competitors', 'pain_points', 'requirements', 'product', 'lost_reason']);

function applyValue({ organizationId, suggestion, value, actorId, actorType = 'user', status = 'approved' }) {
  const table = suggestion.entity_type === 'lead' ? 'leads' : suggestion.entity_type === 'deal' ? 'deals' : null;
  if (!table) throw badRequest(`Cannot apply a suggestion to ${suggestion.entity_type}`);
  const allowed = suggestion.entity_type === 'lead' ? LEAD_TABLE_FIELDS : DEAL_TABLE_FIELDS;
  if (!allowed.has(suggestion.field)) throw badRequest(`Field "${suggestion.field}" is not writable`);

  const before = get(`SELECT * FROM ${table} WHERE id = ? AND organization_id = ?`, [suggestion.entity_id, organizationId]);
  if (!before) throw notFound(suggestion.entity_type === 'lead' ? 'Lead' : 'Deal');

  const stored = Array.isArray(value) ? JSON.stringify(value) : value;
  run(`UPDATE ${table} SET ${suggestion.field} = ?, updated_at = ? WHERE id = ? AND organization_id = ?`,
    [stored, nowIso(), suggestion.entity_id, organizationId]);

  // Stage moves carry extra bookkeeping: history, probability, close-out.
  if (table === 'deals' && suggestion.field === 'stage') {
    insert('deal_stage_history', {
      id: id('dsh'),
      organization_id: organizationId,
      deal_id: suggestion.entity_id,
      from_stage: before.stage,
      to_stage: value,
      changed_by: actorId,
      source: actorType === 'ai' ? 'ai' : 'user',
      created_at: nowIso(),
    });
    run(`UPDATE deals SET stage_entered_at = ?, closed_at = CASE WHEN ? IN ('won','lost') THEN ? ELSE NULL END WHERE id = ?`,
      [nowIso(), value, nowIso(), suggestion.entity_id]);
    webhooks.dispatch(organizationId, 'deal.stage_changed', {
      dealId: suggestion.entity_id, from: before.stage, to: value, source: actorType,
    });
  }

  run(`UPDATE ai_suggestions SET status = ?, applied_value = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
    [status, JSON.stringify(normalise(value)), actorId, nowIso(), suggestion.id]);

  const after = get(`SELECT * FROM ${table} WHERE id = ?`, [suggestion.entity_id]);

  audit.record({
    organizationId,
    actorId,
    actorType: status === 'auto_applied' ? 'ai' : 'user',
    action: status === 'auto_applied' ? 'ai.crm.auto_apply' : 'ai.crm.apply',
    entityType: suggestion.entity_type,
    entityId: suggestion.entity_id,
    before: { [suggestion.field]: before[suggestion.field] },
    after: { [suggestion.field]: stored },
    source: 'ai',
  });

  activity.log({
    organizationId,
    leadId: suggestion.entity_type === 'lead' ? suggestion.entity_id : before.lead_id,
    dealId: suggestion.entity_type === 'deal' ? suggestion.entity_id : null,
    actorId,
    actorType: status === 'auto_applied' ? 'ai' : 'user',
    type: 'crm_change',
    refId: suggestion.id,
    title: `${suggestion.label || suggestion.field} updated${status === 'auto_applied' ? ' automatically by AI' : ' from AI suggestion'}`,
    body: suggestion.rationale,
    metadata: {
      field: suggestion.field,
      from: before[suggestion.field] ?? null,
      to: stored,
      confidence: suggestion.confidence,
      source: suggestion.source_type,
      sourceId: suggestion.source_id,
    },
  });

  reindexEntity(organizationId, suggestion.entity_type, after);
  return after;
}

function reindexEntity(organizationId, entityType, entity) {
  if (!entity) return;
  if (entityType === 'lead') {
    indexRecord({
      organizationId,
      entityType: 'lead',
      entityId: entity.id,
      ownerId: entity.owner_id,
      leadId: entity.id,
      occurredAt: entity.updated_at,
      title: `${entity.first_name} ${entity.last_name || ''} - ${entity.company_name || ''}`.trim(),
      body: [entity.email, entity.phone, entity.job_title, entity.industry, entity.location, entity.status, entity.temperature].filter(Boolean).join(' '),
    });
  } else if (entityType === 'deal') {
    indexRecord({
      organizationId,
      entityType: 'deal',
      entityId: entity.id,
      ownerId: entity.owner_id,
      leadId: entity.lead_id,
      occurredAt: entity.updated_at,
      title: entity.name,
      body: [entity.stage, entity.product, entity.decision_maker, entity.timeline].filter(Boolean).join(' '),
    });
  }
}

/** Approve, edit or reject one suggestion. */
export function decide({ organizationId, suggestionId, action, value, actorId, ownerIds = 'all' }) {
  const suggestion = get('SELECT * FROM ai_suggestions WHERE id = ? AND organization_id = ?', [suggestionId, organizationId]);
  if (!suggestion) throw notFound('Suggestion');
  // Approving writes to a CRM record, so the caller must be allowed to edit it.
  if (!canDecide({ suggestion, ownerIds })) throw forbidden('This suggestion belongs to another agent\'s record');
  if (suggestion.status !== 'pending') return { suggestion: toView(suggestion), unchanged: true };

  if (action === 'reject') {
    run(`UPDATE ai_suggestions SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?`,
      [actorId, nowIso(), suggestionId]);
    audit.record({
      organizationId, actorId, action: 'ai.suggestion.reject', entityType: suggestion.entity_type,
      entityId: suggestion.entity_id, before: { [suggestion.field]: parseJson(suggestion.suggested_value, null) }, source: 'ui',
    });
    return { suggestion: toView(get('SELECT * FROM ai_suggestions WHERE id = ?', [suggestionId])) };
  }

  const applied = action === 'edit' ? coerceValue(suggestion, value) : parseJson(suggestion.suggested_value, null);
  applyValue({
    organizationId,
    suggestion,
    value: applied,
    actorId,
    actorType: 'user',
    status: action === 'edit' ? 'edited' : 'approved',
  });
  return { suggestion: toView(get('SELECT * FROM ai_suggestions WHERE id = ?', [suggestionId])), applied };
}

function coerceValue(suggestion, value) {
  switch (suggestion.value_type) {
    case 'number': {
      const n = Number(String(value).replace(/[^0-9.-]/g, ''));
      if (Number.isNaN(n)) throw badRequest('Value must be a number');
      return n;
    }
    case 'date': {
      const iso = toIso(value);
      if (!iso) throw badRequest('Value must be a valid date');
      return iso;
    }
    case 'array':
      return Array.isArray(value) ? value : String(value).split(',').map((s) => s.trim()).filter(Boolean);
    case 'enum': {
      const definition = AI_FIELD_MAP[`${suggestion.entity_type}.${suggestion.field}`];
      if (definition?.options && !definition.options.includes(value)) {
        throw badRequest(`Value must be one of: ${definition.options.join(', ')}`);
      }
      return value;
    }
    default:
      return value;
  }
}

/** Approve or reject a whole batch in one action. */
export function decideBatch({ organizationId, batchId, action, actorId, only = null, ownerIds = 'all' }) {
  const rows = all(`SELECT * FROM ai_suggestions WHERE organization_id = ? AND batch_id = ? AND status = 'pending'`,
    [organizationId, batchId]);
  const results = [];
  for (const row of rows) {
    if (only && !only.includes(row.id)) continue;
    if (!canDecide({ suggestion: row, ownerIds })) continue;
    try {
      results.push(decide({ organizationId, suggestionId: row.id, action, actorId, ownerIds }).suggestion);
    } catch (error) {
      logger.warn('batch decision failed for suggestion', { suggestionId: row.id, error: error.message });
      results.push({ id: row.id, error: error.message });
    }
  }
  audit.record({
    organizationId, actorId, action: `ai.suggestions.${action}_batch`, entityType: 'suggestion_batch',
    entityId: batchId, after: { count: results.length }, source: 'ui',
  });
  return results;
}

export function toView(row) {
  return {
    id: row.id,
    batchId: row.batch_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    field: row.field,
    label: row.label,
    currentValue: parseJson(row.current_value, null),
    suggestedValue: parseJson(row.suggested_value, null),
    appliedValue: parseJson(row.applied_value, null),
    valueType: row.value_type,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    rationale: row.rationale,
    evidence: parseJson(row.evidence, []),
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

/**
 * SQL fragment restricting suggestions to records the caller may see.
 *
 * A suggestion carries the field name, the current value, the proposed value
 * and a verbatim transcript quote -- so an unscoped queue would leak another
 * agent's conversation. Scope is applied here, in the data layer, rather than
 * being left to each caller.
 */
function ownerScope(ownerIds) {
  if (!ownerIds || ownerIds === 'all') return { sql: '', params: [] };
  const ids = Array.isArray(ownerIds) ? ownerIds : [ownerIds];
  if (!ids.length) return { sql: ' AND 1 = 0', params: [] };
  const placeholders = ids.map(() => '?').join(', ');
  return {
    sql: ` AND (
      (entity_type = 'lead' AND entity_id IN (SELECT id FROM leads WHERE owner_id IN (${placeholders})))
      OR (entity_type = 'deal' AND entity_id IN (SELECT id FROM deals WHERE owner_id IN (${placeholders})))
    )`,
    params: [...ids, ...ids],
  };
}

/** True when the caller may act on this suggestion's target record. */
export function canDecide({ suggestion, ownerIds }) {
  if (!ownerIds || ownerIds === 'all') return true;
  const ids = Array.isArray(ownerIds) ? ownerIds : [ownerIds];
  const table = suggestion.entity_type === 'lead' ? 'leads' : suggestion.entity_type === 'deal' ? 'deals' : null;
  if (!table) return false;
  const record = get(`SELECT owner_id FROM ${table} WHERE id = ?`, [suggestion.entity_id]);
  if (!record) return false;
  return !record.owner_id || ids.includes(record.owner_id);
}

export function listSuggestions({ organizationId, ownerIds = 'all', batchId, entityType, entityId, status = 'pending', limit = 100 }) {
  const scope = ownerScope(ownerIds);
  const params = [organizationId, ...scope.params];
  let sql = `SELECT * FROM ai_suggestions WHERE organization_id = ?${scope.sql}`;
  if (batchId) {
    sql += ' AND batch_id = ?';
    params.push(batchId);
  }
  if (entityType) {
    sql += ' AND entity_type = ?';
    params.push(entityType);
  }
  if (entityId) {
    sql += ' AND entity_id = ?';
    params.push(entityId);
  }
  if (status && status !== 'all') {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY sensitivity DESC, confidence DESC, created_at DESC LIMIT ?';
  params.push(limit);
  return all(sql, params).map(toView);
}

export default {
  buildSuggestions, persistSuggestions, decide, decideBatch, listSuggestions, canDecide, scoreLead, toView,
};
