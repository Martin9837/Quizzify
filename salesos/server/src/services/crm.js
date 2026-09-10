import { all, get, insert, run, update, transaction, parseJson } from '../db/index.js';
import { id } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { toE164, countryFromE164 } from '../lib/phone.js';
import { sha256 } from '../lib/crypto.js';
import { STAGE_MAP, LEAD_STATUSES, LEAD_TEMPERATURES } from '../lib/constants.js';
import { conflict, notFound } from '../lib/errors.js';
import * as audit from './audit.js';
import * as activity from './activity.js';
import * as webhooks from './webhooks.js';
import * as notifications from './notifications/index.js';
import { assignLead } from './automation/index.js';
import { indexRecord, removeFromIndex } from './search/index.js';
import logger from '../lib/logger.js';

/**
 * CRM domain service: leads, companies, deals, and the import path.
 * Route handlers stay thin; every rule that must hold regardless of entry point
 * (dedupe, assignment, timeline writes, search indexing) lives here.
 */

// ------------------------------------------------------------------ leads ----
const LEAD_JSON_FIELDS = ['tags', 'custom_fields', 'ai_snapshot'];

export function leadView(row, { includeInternal = false } = {}) {
  if (!row) return null;
  const view = {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    name: `${row.first_name} ${row.last_name || ''}`.trim(),
    companyId: row.company_id,
    companyName: row.company_name,
    jobTitle: row.job_title,
    phone: row.phone_e164 || row.phone,
    secondaryPhone: row.secondary_phone,
    email: row.email,
    location: row.location,
    country: row.country,
    timezone: row.timezone,
    source: row.source,
    industry: row.industry,
    status: row.status,
    temperature: row.temperature,
    score: row.score,
    tags: parseJson(row.tags, []),
    ownerId: row.owner_id,
    ownerName: row.owner_name || null,
    dealValue: row.deal_value,
    expectedCloseDate: row.expected_close_date,
    nextFollowUpAt: row.next_follow_up_at,
    lastContactedAt: row.last_contacted_at,
    firstResponseSeconds: row.first_response_seconds,
    doNotCall: Boolean(row.do_not_call),
    consentRecording: row.consent_recording,
    customFields: parseJson(row.custom_fields, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeInternal) {
    view.aiSnapshot = parseJson(row.ai_snapshot, {});
    view.dedupeKey = row.dedupe_key;
    view.archivedAt = row.archived_at;
  }
  return view;
}

/**
 * Duplicate detection key. Email wins when present (it is the strongest
 * identifier), then normalised phone, then a name+company fingerprint.
 */
export function dedupeKeyFor({ email, phoneE164, firstName, lastName, companyName }) {
  if (email) return `email:${String(email).trim().toLowerCase()}`;
  if (phoneE164) return `phone:${phoneE164}`;
  const fingerprint = [firstName, lastName, companyName]
    .map((v) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(Boolean)
    .join('|');
  return fingerprint ? `name:${sha256(fingerprint).slice(0, 24)}` : null;
}

export function findDuplicate({ organizationId, dedupeKey, email, phoneE164 }) {
  if (dedupeKey) {
    const byKey = get('SELECT * FROM leads WHERE organization_id = ? AND dedupe_key = ? AND archived_at IS NULL', [organizationId, dedupeKey]);
    if (byKey) return byKey;
  }
  if (email) {
    const byEmail = get('SELECT * FROM leads WHERE organization_id = ? AND LOWER(email) = ? AND archived_at IS NULL', [organizationId, String(email).toLowerCase()]);
    if (byEmail) return byEmail;
  }
  if (phoneE164) {
    const byPhone = get('SELECT * FROM leads WHERE organization_id = ? AND phone_e164 = ? AND archived_at IS NULL', [organizationId, phoneE164]);
    if (byPhone) return byPhone;
  }
  return null;
}

/**
 * A company named by id, in this organisation. Anything else is the caller's
 * mistake, not a silently dropped field.
 */
function requireCompany(organizationId, companyId) {
  const company = get('SELECT * FROM companies WHERE id = ? AND organization_id = ?', [companyId, organizationId]);
  if (!company) throw notFound('Company');
  return company;
}

export function ensureCompany({ organizationId, name, domain, industry, location }) {
  if (!name) return null;
  const existing = get('SELECT * FROM companies WHERE organization_id = ? AND LOWER(name) = ?', [organizationId, name.toLowerCase()]);
  if (existing) return existing;
  const row = {
    id: id('cmp'),
    organization_id: organizationId,
    name,
    domain: domain || null,
    industry: industry || null,
    location: location || null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('companies', row);
  indexRecord({
    organizationId, entityType: 'company', entityId: row.id, occurredAt: row.created_at,
    title: name, body: [domain, industry, location].filter(Boolean).join(' '),
  });
  return row;
}

export function createLead({ organizationId, data, actorId, source = 'ui', autoAssign = true, allowDuplicate = false }) {
  const phoneE164 = toE164(data.phone, data.country || 'US');
  const dedupeKey = dedupeKeyFor({
    email: data.email, phoneE164, firstName: data.firstName, lastName: data.lastName, companyName: data.companyName,
  });

  const duplicate = allowDuplicate ? null : findDuplicate({ organizationId, dedupeKey, email: data.email, phoneE164 });
  if (duplicate) {
    throw conflict('A lead with these details already exists', {
      duplicateOf: duplicate.id,
      matchedOn: dedupeKey?.split(':')[0] || 'unknown',
      lead: leadView(duplicate),
    });
  }

  // An explicit companyId wins; otherwise the company is matched, and created
  // if need be, from the name. companyId used to be accepted by nothing at all
  // -- it was read back on every lead but silently dropped from the request
  // that set it, so a lead created before its company, or spelled differently,
  // could never be linked.
  const company = data.companyId
    ? requireCompany(organizationId, data.companyId)
    : (data.companyName
      ? ensureCompany({ organizationId, name: data.companyName, industry: data.industry, location: data.location })
      : null);

  let ownerId = data.ownerId || null;
  let assignment = null;
  if (!ownerId && autoAssign) {
    assignment = assignLead({ organizationId, lead: { ...data, source: data.source } });
    // Falls back to whoever is creating the lead, as createDeal already did.
    // An unowned lead is invisible to the owner-scoped dashboard.
    ownerId = assignment?.ownerId || actorId || null;
  }

  const row = {
    id: id('lead'),
    organization_id: organizationId,
    company_id: company?.id || null,
    first_name: data.firstName,
    last_name: data.lastName || null,
    company_name: data.companyName || null,
    job_title: data.jobTitle || null,
    phone: data.phone || null,
    phone_e164: phoneE164,
    secondary_phone: data.secondaryPhone ? toE164(data.secondaryPhone, data.country || 'US') : null,
    email: data.email ? String(data.email).trim().toLowerCase() : null,
    location: data.location || null,
    country: data.country || (phoneE164 ? countryFromE164(phoneE164) : null),
    timezone: data.timezone || null,
    source: data.source || 'other',
    industry: data.industry || null,
    status: LEAD_STATUSES.includes(data.status) ? data.status : 'new',
    temperature: LEAD_TEMPERATURES.includes(data.temperature) ? data.temperature : 'cold',
    score: Number.isFinite(data.score) ? data.score : initialScore(data),
    tags: JSON.stringify(data.tags || []),
    owner_id: ownerId,
    deal_value: data.dealValue ?? 0,
    expected_close_date: data.expectedCloseDate || null,
    next_follow_up_at: data.nextFollowUpAt || null,
    do_not_call: data.doNotCall ? 1 : 0,
    consent_recording: data.consentRecording || 'unknown',
    custom_fields: JSON.stringify(data.customFields || {}),
    ai_snapshot: '{}',
    dedupe_key: dedupeKey,
    created_by: actorId || null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('leads', row);

  // An open deal is created up front when a value is known: pipeline reporting
  // depends on every real opportunity existing as a deal, not just a lead.
  let deal = null;
  if (data.dealValue > 0 || data.createDeal) {
    deal = createDeal({
      organizationId,
      actorId,
      data: {
        leadId: row.id,
        name: `${data.companyName || row.first_name} - ${data.product || 'New opportunity'}`,
        value: data.dealValue || 0,
        stage: 'new_lead',
        ownerId,
        expectedCloseDate: data.expectedCloseDate || null,
      },
      silent: true,
    });
  }

  indexRecord({
    organizationId,
    entityType: 'lead',
    entityId: row.id,
    ownerId,
    leadId: row.id,
    occurredAt: row.created_at,
    title: `${row.first_name} ${row.last_name || ''} - ${row.company_name || ''}`.trim(),
    body: [row.email, row.phone_e164, row.job_title, row.industry, row.location, row.source, ...(data.tags || [])].filter(Boolean).join(' '),
  });

  activity.log({
    organizationId,
    leadId: row.id,
    dealId: deal?.id || null,
    actorId,
    type: 'lead_created',
    refId: row.id,
    title: `Lead created: ${row.first_name} ${row.last_name || ''}`.trim(),
    metadata: { source: row.source, assignedTo: ownerId, rule: assignment?.ruleName || null },
  });

  audit.record({
    organizationId, actorId, action: 'lead.create', entityType: 'lead', entityId: row.id,
    after: row, source,
  });

  if (ownerId && ownerId !== actorId) {
    notifications.notify({
      organizationId,
      userId: ownerId,
      type: 'new_lead',
      title: `New lead assigned: ${row.first_name} ${row.last_name || ''}`.trim(),
      body: [row.company_name, row.job_title, row.source && `via ${row.source.replace('_', ' ')}`].filter(Boolean).join(' - '),
      entityType: 'lead',
      entityId: row.id,
      link: `/leads/${row.id}`,
      priority: row.temperature === 'hot' ? 'high' : 'normal',
    });
  }

  webhooks.dispatch(organizationId, 'lead.created', { leadId: row.id, ownerId, source: row.source });
  return { lead: leadView(row), deal, assignment };
}

/** Starting score before any conversation has happened. */
function initialScore(data) {
  let score = 20;
  const highIntentSources = { referral: 25, inbound_form: 20, webinar: 12, content: 8, partner: 15 };
  score += highIntentSources[data.source] || 0;
  if (data.email) score += 5;
  if (data.phone) score += 5;
  if (data.jobTitle && /\b(chief|vp|vice president|head|director|founder|owner|c[oe]o|cto|cfo|cro)\b/i.test(data.jobTitle)) score += 15;
  if (data.dealValue > 50000) score += 10;
  return Math.min(100, score);
}

export function updateLead({ organizationId, leadId, patch, actorId, source = 'ui' }) {
  const before = get('SELECT * FROM leads WHERE id = ? AND organization_id = ?', [leadId, organizationId]);
  if (!before) throw notFound('Lead');

  const mapped = {};
  const map = {
    firstName: 'first_name', lastName: 'last_name', companyName: 'company_name', jobTitle: 'job_title',
    email: 'email', location: 'location', country: 'country', timezone: 'timezone', source: 'source',
    industry: 'industry', status: 'status', temperature: 'temperature', score: 'score',
    ownerId: 'owner_id', dealValue: 'deal_value', expectedCloseDate: 'expected_close_date',
    nextFollowUpAt: 'next_follow_up_at', doNotCall: 'do_not_call', consentRecording: 'consent_recording',
    secondaryPhone: 'secondary_phone',
  };
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] !== undefined) mapped[column] = typeof patch[key] === 'boolean' ? (patch[key] ? 1 : 0) : patch[key];
  }
  if (patch.phone !== undefined) {
    mapped.phone = patch.phone;
    mapped.phone_e164 = toE164(patch.phone, patch.country || before.country || 'US');
  }
  if (patch.companyId !== undefined) {
    mapped.company_id = patch.companyId ? requireCompany(organizationId, patch.companyId).id : null;
  } else if (patch.companyName !== undefined && patch.companyName && !before.company_id) {
    // Renaming an unlinked lead's company links it, the same way creating one
    // does. Without this the column could only ever be set at creation.
    mapped.company_id = ensureCompany({
      organizationId, name: patch.companyName, industry: before.industry, location: before.location,
    })?.id || null;
  }
  if (patch.tags !== undefined) mapped.tags = JSON.stringify(patch.tags);
  if (patch.customFields !== undefined) {
    mapped.custom_fields = JSON.stringify({ ...parseJson(before.custom_fields, {}), ...patch.customFields });
  }
  if (mapped.email || mapped.phone_e164) {
    mapped.dedupe_key = dedupeKeyFor({
      email: mapped.email ?? before.email,
      phoneE164: mapped.phone_e164 ?? before.phone_e164,
      firstName: mapped.first_name ?? before.first_name,
      lastName: mapped.last_name ?? before.last_name,
      companyName: mapped.company_name ?? before.company_name,
    });
  }
  mapped.updated_at = nowIso();

  update('leads', leadId, organizationId, mapped);
  const after = get('SELECT * FROM leads WHERE id = ?', [leadId]);

  const diff = audit.diffOf(before, after);
  if (diff) {
    audit.record({
      organizationId, actorId, action: 'lead.update', entityType: 'lead', entityId: leadId,
      before, after, source,
    });
    activity.log({
      organizationId, leadId, actorId, type: 'crm_change', refId: leadId,
      title: `Lead updated: ${Object.keys(diff).filter((k) => k !== 'updated_at').join(', ')}`,
      metadata: { diff },
    });
  }

  if (mapped.owner_id && mapped.owner_id !== before.owner_id) {
    // Not to the person who did it. createLead already guards this with
    // `ownerId !== actorId`; here it was missing, so taking a lead yourself
    // sent you "Lead reassigned to you". The webhook still fires either way --
    // an integration wants the assignment regardless of who made it.
    if (mapped.owner_id !== actorId) {
      notifications.notify({
        organizationId,
        userId: mapped.owner_id,
        type: 'new_lead',
        title: `Lead reassigned to you: ${after.first_name} ${after.last_name || ''}`.trim(),
        body: after.company_name,
        entityType: 'lead',
        entityId: leadId,
        link: `/leads/${leadId}`,
      });
    }
    webhooks.dispatch(organizationId, 'lead.assigned', { leadId, ownerId: mapped.owner_id, previousOwnerId: before.owner_id });
  }

  indexRecord({
    organizationId, entityType: 'lead', entityId: leadId, ownerId: after.owner_id, leadId,
    occurredAt: after.updated_at,
    title: `${after.first_name} ${after.last_name || ''} - ${after.company_name || ''}`.trim(),
    body: [after.email, after.phone_e164, after.job_title, after.industry, after.location, after.status, after.temperature].filter(Boolean).join(' '),
  });

  webhooks.dispatch(organizationId, 'lead.updated', { leadId, changed: Object.keys(diff || {}) });
  return leadView(after);
}

export function archiveLead({ organizationId, leadId, actorId }) {
  const lead = get('SELECT * FROM leads WHERE id = ? AND organization_id = ?', [leadId, organizationId]);
  if (!lead) throw notFound('Lead');

  // The lead's open deals close with it, as lost, saying why.
  //
  // Archiving used to touch the lead alone, which left its deals in the live
  // forecast for a contact who was no longer in the lead list and could not be
  // opened -- inflating openValue, weightedForecast and the company's pipeline
  // with a deal nobody could reach, let alone close. Deals have no archived
  // state of their own and every aggregate keys off `stage`, so the honest
  // resting place for an opportunity whose contact is gone is lost, with a
  // reason recorded rather than left blank.
  //
  // Closed deals are untouched: archiving a customer must not erase the
  // revenue they brought in. Through updateDeal so each one gets its stage
  // history, its activity entry and the deal.lost webhook, exactly as it would
  // if someone had closed it by hand.
  const open = all(
    `SELECT id FROM deals WHERE lead_id = ? AND organization_id = ? AND stage NOT IN ('won','lost')`,
    [leadId, organizationId],
  );
  for (const deal of open) {
    updateDeal({
      organizationId,
      dealId: deal.id,
      patch: { stage: 'lost', lostReason: 'Lead archived' },
      actorId,
    });
  }

  run('UPDATE leads SET archived_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), leadId]);
  removeFromIndex('lead', leadId);
  audit.record({
    organizationId, actorId, action: 'lead.archive', entityType: 'lead', entityId: leadId,
    before: { archived_at: null },
    after: { archived_at: nowIso(), deals_closed: open.length },
    source: 'ui',
  });
  return { archived: true, dealsClosed: open.length };
}

// ------------------------------------------------------------------ deals ----
export function dealView(row) {
  if (!row) return null;
  return {
    id: row.id,
    leadId: row.lead_id,
    companyId: row.company_id,
    name: row.name,
    stage: row.stage,
    stageLabel: STAGE_MAP[row.stage]?.label || row.stage,
    value: row.value,
    currency: row.currency,
    probability: row.probability,
    weightedValue: Math.round((row.value || 0) * (row.probability || 0) / 100),
    expectedCloseDate: row.expected_close_date,
    ownerId: row.owner_id,
    ownerName: row.owner_name || null,
    contactName: row.first_name ? `${row.first_name} ${row.last_name || ''}`.trim() : null,
    companyName: row.company_name || null,
    product: row.product,
    competitors: parseJson(row.competitors, []),
    painPoints: parseJson(row.pain_points, []),
    requirements: parseJson(row.requirements, []),
    decisionMaker: row.decision_maker,
    budget: row.budget,
    timeline: row.timeline,
    riskScore: row.risk_score,
    riskReasons: parseJson(row.risk_reasons, []),
    health: row.health,
    stageEnteredAt: row.stage_entered_at,
    closedAt: row.closed_at,
    lostReason: row.lost_reason,
    position: row.position,
    customFields: parseJson(row.custom_fields, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createDeal({ organizationId, data, actorId, silent = false }) {
  const lead = data.leadId ? get('SELECT * FROM leads WHERE id = ? AND organization_id = ?', [data.leadId, organizationId]) : null;
  if (data.leadId && !lead) throw notFound('Lead');
  const stage = STAGE_MAP[data.stage] ? data.stage : 'new_lead';
  const row = {
    id: id('deal'),
    organization_id: organizationId,
    lead_id: data.leadId || null,
    company_id: lead?.company_id || null,
    name: data.name || `${lead?.company_name || 'New'} opportunity`,
    stage,
    value: data.value || 0,
    currency: data.currency || 'USD',
    probability: data.probability ?? STAGE_MAP[stage].probability,
    expected_close_date: data.expectedCloseDate || null,
    owner_id: data.ownerId || lead?.owner_id || actorId || null,
    product: data.product || null,
    competitors: JSON.stringify(data.competitors || []),
    pain_points: JSON.stringify(data.painPoints || []),
    requirements: JSON.stringify(data.requirements || []),
    decision_maker: data.decisionMaker || null,
    budget: data.budget || null,
    timeline: data.timeline || null,
    risk_score: 0,
    risk_reasons: '[]',
    health: 'unknown',
    stage_entered_at: nowIso(),
    // Set here as well as on transition. Without it a deal imported straight
    // in as won or lost had closed_at NULL, and every revenue, win-rate and
    // quota query filters on closed_at -- so /deals/pipeline reported the
    // won value while /analytics/dashboard reported zero revenue for the same
    // row, and one won plus one lost deal gave a win rate of 0%.
    closed_at: ['won', 'lost'].includes(stage) ? nowIso() : null,
    lost_reason: stage === 'lost' ? (data.lostReason || null) : null,
    position: nextPosition(organizationId, stage),
    custom_fields: JSON.stringify(data.customFields || {}),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('deals', row);
  insert('deal_stage_history', {
    id: id('dsh'),
    organization_id: organizationId,
    deal_id: row.id,
    from_stage: null,
    to_stage: stage,
    changed_by: actorId,
    source: 'user',
    created_at: nowIso(),
  });

  indexRecord({
    organizationId, entityType: 'deal', entityId: row.id, ownerId: row.owner_id, leadId: row.lead_id,
    occurredAt: row.created_at, title: row.name,
    body: [stage, row.product, row.decision_maker, row.timeline].filter(Boolean).join(' '),
  });

  // `silent` suppresses the duplicate feed entry only. It used to suppress the
  // audit row and the deal.created webhook as well, so a deal created
  // alongside its lead -- the createDeal:true path -- appeared in no audit log
  // and fired no webhook: an audit trail that records a creation depending on
  // which entry point was used is not an audit trail.
  if (!silent) {
    activity.log({
      organizationId, leadId: row.lead_id, dealId: row.id, actorId, type: 'stage_change',
      refId: row.id, title: `Deal created: ${row.name}`,
      metadata: { stage, value: row.value },
    });
  }
  audit.record({ organizationId, actorId, action: 'deal.create', entityType: 'deal', entityId: row.id, after: row, source: 'ui' });
  webhooks.dispatch(organizationId, 'deal.created', { dealId: row.id, leadId: row.lead_id, value: row.value });
  return dealView(row);
}

function nextPosition(organizationId, stage) {
  const row = get('SELECT COALESCE(MAX(position), 0) AS p FROM deals WHERE organization_id = ? AND stage = ?', [organizationId, stage]);
  return (row?.p || 0) + 1;
}

export function updateDeal({ organizationId, dealId, patch, actorId, source = 'ui' }) {
  const before = get('SELECT * FROM deals WHERE id = ? AND organization_id = ?', [dealId, organizationId]);
  if (!before) throw notFound('Deal');

  const map = {
    name: 'name', stage: 'stage', value: 'value', currency: 'currency', probability: 'probability',
    expectedCloseDate: 'expected_close_date', ownerId: 'owner_id', product: 'product',
    decisionMaker: 'decision_maker', budget: 'budget', timeline: 'timeline', lostReason: 'lost_reason',
    position: 'position',
  };
  const mapped = {};
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] !== undefined) mapped[column] = patch[key];
  }
  for (const key of ['competitors', 'painPoints', 'requirements']) {
    if (patch[key] !== undefined) {
      mapped[{ competitors: 'competitors', painPoints: 'pain_points', requirements: 'requirements' }[key]] = JSON.stringify(patch[key]);
    }
  }
  if (patch.customFields !== undefined) {
    mapped.custom_fields = JSON.stringify({ ...parseJson(before.custom_fields, {}), ...patch.customFields });
  }

  const stageChanged = mapped.stage && mapped.stage !== before.stage;
  if (stageChanged) {
    if (!STAGE_MAP[mapped.stage]) throw notFound('Stage');
    mapped.stage_entered_at = nowIso();
    // Probability follows the stage unless the user set it explicitly.
    if (patch.probability === undefined) mapped.probability = STAGE_MAP[mapped.stage].probability;
    mapped.closed_at = ['won', 'lost'].includes(mapped.stage) ? nowIso() : null;
    if (mapped.stage !== before.stage && !['won', 'lost'].includes(mapped.stage)) mapped.position = nextPosition(organizationId, mapped.stage);
  }
  mapped.updated_at = nowIso();

  transaction(() => {
    update('deals', dealId, organizationId, mapped);
    if (stageChanged) {
      insert('deal_stage_history', {
        id: id('dsh'),
        organization_id: organizationId,
        deal_id: dealId,
        from_stage: before.stage,
        to_stage: mapped.stage,
        changed_by: actorId,
        source: source === 'ai' ? 'ai' : 'user',
        created_at: nowIso(),
      });
    }
  });

  const after = get('SELECT * FROM deals WHERE id = ?', [dealId]);

  if (stageChanged) {
    activity.log({
      organizationId, leadId: after.lead_id, dealId, actorId,
      actorType: source === 'ai' ? 'ai' : 'user', type: 'stage_change', refId: dealId,
      title: `Deal moved: ${STAGE_MAP[before.stage]?.label || before.stage} to ${STAGE_MAP[after.stage]?.label || after.stage}`,
      metadata: { from: before.stage, to: after.stage, value: after.value },
    });
    webhooks.dispatch(organizationId, after.stage === 'won' ? 'deal.won' : after.stage === 'lost' ? 'deal.lost' : 'deal.stage_changed', {
      dealId, from: before.stage, to: after.stage, value: after.value,
    });
    if (['won', 'lost'].includes(after.stage)) {
      notifications.notifyManagers({
        organizationId,
        type: 'deal',
        title: `Deal ${after.stage}: ${after.name} (${after.currency} ${Math.round(after.value).toLocaleString('en-US')})`,
        body: after.stage === 'lost' ? after.lost_reason || 'No reason recorded' : 'Congratulations to the team.',
        entityType: 'deal',
        entityId: dealId,
        link: `/pipeline`,
        priority: 'normal',
      });
    }
    if (after.lead_id && after.stage === 'won') {
      run(`UPDATE leads SET status = 'customer', updated_at = ? WHERE id = ?`, [nowIso(), after.lead_id]);
    }
  }

  const diff = audit.diffOf(before, after);
  if (diff) {
    audit.record({ organizationId, actorId, action: 'deal.update', entityType: 'deal', entityId: dealId, before, after, source });
  }

  indexRecord({
    organizationId, entityType: 'deal', entityId: dealId, ownerId: after.owner_id, leadId: after.lead_id,
    occurredAt: after.updated_at, title: after.name,
    body: [after.stage, after.product, after.decision_maker, after.timeline, after.lost_reason].filter(Boolean).join(' '),
  });

  return dealView(after);
}

// ----------------------------------------------------------------- import ----
/**
 * Bulk import. Rows are validated individually so one bad line never aborts the
 * batch; duplicates are reported rather than silently merged, because a silent
 * merge is how CRM data becomes untrustworthy.
 */
export function importLeads({ organizationId, rows, actorId, importId = null, allowDuplicates = false }) {
  const result = { importId: importId || id('imp'), created: 0, duplicates: 0, errors: [], leadIds: [] };

  for (const [index, raw] of rows.entries()) {
    try {
      const data = normaliseImportRow(raw);
      if (!data.firstName) throw new Error('A first name (or full name) is required');
      if (!data.email && !data.phone) throw new Error('Either an email address or a phone number is required');
      const created = createLead({
        organizationId,
        data: { ...data, source: data.source || 'import' },
        actorId,
        source: 'import',
        allowDuplicate: allowDuplicates,
      });
      result.created += 1;
      result.leadIds.push(created.lead.id);
    } catch (error) {
      if (error.code === 'conflict') {
        result.duplicates += 1;
        result.errors.push({ row: index + 1, reason: 'duplicate', duplicateOf: error.details?.duplicateOf, matchedOn: error.details?.matchedOn });
      } else {
        result.errors.push({ row: index + 1, reason: error.message });
      }
    }
  }

  audit.record({
    organizationId, actorId, action: 'lead.import', entityType: 'import', entityId: result.importId,
    after: { created: result.created, duplicates: result.duplicates, errors: result.errors.length }, source: 'ui',
  });
  logger.info('lead import complete', { organizationId, ...result, errors: result.errors.length });
  return result;
}

const HEADER_ALIASES = {
  firstName: ['first name', 'firstname', 'first', 'given name', 'name', 'full name', 'contact', 'contact name'],
  lastName: ['last name', 'lastname', 'surname', 'family name'],
  companyName: ['company', 'company name', 'organisation', 'organization', 'account', 'employer'],
  jobTitle: ['title', 'job title', 'position', 'role'],
  phone: ['phone', 'phone number', 'mobile', 'telephone', 'tel', 'cell', 'work phone'],
  secondaryPhone: ['secondary phone', 'alt phone', 'other phone'],
  email: ['email', 'e-mail', 'email address', 'work email'],
  location: ['location', 'city', 'address', 'region'],
  country: ['country', 'country code'],
  source: ['source', 'lead source', 'channel'],
  industry: ['industry', 'sector', 'vertical'],
  status: ['status', 'lead status'],
  temperature: ['temperature', 'priority', 'heat'],
  dealValue: ['deal value', 'value', 'amount', 'opportunity value', 'potential value'],
  expectedCloseDate: ['expected close date', 'close date', 'closing date'],
  tags: ['tags', 'labels', 'keywords'],
  ownerId: ['owner id', 'assigned to id'],
};

/** Map a spreadsheet row onto lead fields, tolerating messy headers. */
export function normaliseImportRow(raw) {
  const lowered = {};
  for (const [key, value] of Object.entries(raw)) {
    lowered[String(key).trim().toLowerCase()] = typeof value === 'string' ? value.trim() : value;
  }

  const take = (field) => {
    for (const alias of HEADER_ALIASES[field] || []) {
      if (lowered[alias] !== undefined && lowered[alias] !== '') return lowered[alias];
    }
    return undefined;
  };

  const data = {
    firstName: take('firstName'),
    lastName: take('lastName'),
    companyName: take('companyName'),
    jobTitle: take('jobTitle'),
    phone: take('phone'),
    secondaryPhone: take('secondaryPhone'),
    email: take('email'),
    location: take('location'),
    country: take('country'),
    source: take('source'),
    industry: take('industry'),
    status: take('status'),
    temperature: take('temperature'),
    dealValue: take('dealValue'),
    expectedCloseDate: take('expectedCloseDate'),
    tags: take('tags'),
    ownerId: take('ownerId'),
  };

  // A single "name" column is common in exports; split it on the last space.
  if (data.firstName && !data.lastName && /\s/.test(data.firstName)) {
    const parts = String(data.firstName).split(/\s+/);
    data.lastName = parts.slice(1).join(' ');
    data.firstName = parts[0];
  }
  if (typeof data.tags === 'string') data.tags = data.tags.split(/[;,|]/).map((t) => t.trim()).filter(Boolean);
  if (data.dealValue !== undefined) {
    const numeric = Number(String(data.dealValue).replace(/[^0-9.-]/g, ''));
    data.dealValue = Number.isFinite(numeric) ? numeric : 0;
  }
  if (data.expectedCloseDate) {
    const parsed = new Date(data.expectedCloseDate);
    data.expectedCloseDate = Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (data.status) data.status = String(data.status).toLowerCase().replace(/\s+/g, '_');
  if (data.temperature) data.temperature = String(data.temperature).toLowerCase();
  if (data.source) data.source = String(data.source).toLowerCase().replace(/\s+/g, '_');

  // Unmapped columns are preserved as custom fields rather than dropped.
  const known = new Set(Object.values(HEADER_ALIASES).flat());
  const customFields = {};
  for (const [key, value] of Object.entries(lowered)) {
    if (!known.has(key) && value !== '' && value !== null && value !== undefined) {
      customFields[key.replace(/\s+/g, '_')] = value;
    }
  }
  if (Object.keys(customFields).length) data.customFields = customFields;

  return data;
}

/** Minimal RFC-4180 CSV parser (quoted fields, embedded commas and newlines). */
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const source = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => String(h).trim());
  const records = nonEmpty.slice(1).map((cells) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = cells[index] ?? '';
    });
    return record;
  });
  return { headers, rows: records };
}

/** Bulk field update across many leads (owner change, tagging, status moves). */
export function bulkUpdateLeads({ organizationId, leadIds, patch, actorId }) {
  const results = { updated: 0, failed: [] };
  for (const leadId of leadIds) {
    try {
      updateLead({ organizationId, leadId, patch, actorId, source: 'bulk' });
      results.updated += 1;
    } catch (error) {
      results.failed.push({ leadId, reason: error.message });
    }
  }
  audit.record({
    organizationId, actorId, action: 'lead.bulk_update', entityType: 'lead', entityId: null,
    after: { count: results.updated, patch }, source: 'ui',
  });
  return results;
}

export default {
  leadView, dealView, createLead, updateLead, archiveLead, createDeal, updateDeal,
  importLeads, parseCsv, normaliseImportRow, bulkUpdateLeads, dedupeKeyFor, findDuplicate, ensureCompany,
};
