/**
 * Demo data seeder.
 *
 * Builds a believable organisation and then runs the *real* post-call pipeline
 * over the generated calls -- transcription, analysis, CRM extraction,
 * suggestions, tasks. Nothing here fabricates analysis output: the seeded
 * insights are produced by the same code that runs in production, which is what
 * makes the demo data a useful test of the system rather than a mock of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { getDb, migrate, all, get, insert, run, closeDb } from './index.js';
import { id } from '../lib/ids.js';
import { hashPassword } from '../lib/crypto.js';
import { nowIso, addDays, addHours, addMinutes, startOfDay, nextBusinessSlot } from '../lib/time.js';
import { toE164 } from '../lib/phone.js';
import { DEFAULT_ORG_SETTINGS, STAGE_MAP } from '../lib/constants.js';
import logger from '../lib/logger.js';
import * as ai from '../services/ai/index.js';
import * as extraction from '../services/ai/extraction.js';
import * as automation from '../services/automation/index.js';
import * as activityService from '../services/activity.js';
import { reindexOrganization } from '../services/search/index.js';
import { invalidate } from '../services/org.js';

// Deterministic PRNG so every seed run produces the same organisation.
let seedState = 20260801;
function rand() {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return seedState / 4294967296;
}
const pick = (list) => list[Math.floor(rand() * list.length)];
const pickN = (list, n) => {
  const copy = [...list];
  const out = [];
  while (out.length < n && copy.length) out.push(...copy.splice(Math.floor(rand() * copy.length), 1));
  return out;
};
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const chance = (p) => rand() < p;

const FIRST_NAMES = ['Dana', 'Marcus', 'Priya', 'Tomas', 'Alina', 'Jordan', 'Nadia', 'Felix', 'Grace', 'Omar',
  'Sofia', 'Liam', 'Yuki', 'Elena', 'Caleb', 'Ines', 'Mateo', 'Hannah', 'Dmitri', 'Chiara',
  'Noah', 'Amara', 'Victor', 'Leila', 'Simon', 'Farah', 'Erik', 'Rosa', 'Aditya', 'Maja',
  'Julian', 'Keisha', 'Ravi', 'Marta', 'Theo', 'Bianca', 'Anders', 'Zoe', 'Hugo', 'Neha'];
const LAST_NAMES = ['Whitfield', 'Lee', 'Raman', 'Novak', 'Petrova', 'Blake', 'Haddad', 'Berger', 'Okonkwo', 'Nasser',
  'Moreau', 'Kelly', 'Tanaka', 'Costa', 'Bright', 'Duarte', 'Rivas', 'Schmidt', 'Volkov', 'Ferrari',
  'Andersen', 'Boateng', 'Ionescu', 'Karim', 'Lindqvist', 'Mansour', 'Larsen', 'Delgado', 'Kapoor', 'Sorensen'];

const COMPANIES = [
  { name: 'Northwind Logistics', domain: 'northwindlogistics.com', industry: 'Logistics', size: '500-1000', location: 'Chicago, US', country: 'US' },
  { name: 'Helix Bioscience', domain: 'helixbio.io', industry: 'Biotech', size: '200-500', location: 'Cambridge, GB', country: 'GB' },
  { name: 'Vantage Financial', domain: 'vantagefin.com', industry: 'Financial Services', size: '1000-5000', location: 'New York, US', country: 'US' },
  { name: 'Brightpath Education', domain: 'brightpath.edu', industry: 'Education', size: '100-200', location: 'Austin, US', country: 'US' },
  { name: 'Meridian Manufacturing', domain: 'meridianmfg.de', industry: 'Manufacturing', size: '1000-5000', location: 'Munich, DE', country: 'DE' },
  { name: 'Cobalt Energy', domain: 'cobaltenergy.no', industry: 'Energy', size: '500-1000', location: 'Oslo, NO', country: 'NO' },
  { name: 'Lumen Retail Group', domain: 'lumenretail.com', industry: 'Retail', size: '5000+', location: 'Toronto, CA', country: 'CA' },
  { name: 'Ardent Healthcare', domain: 'ardenthealth.com', industry: 'Healthcare', size: '1000-5000', location: 'Boston, US', country: 'US' },
  { name: 'Kestrel Software', domain: 'kestrel.dev', industry: 'Software', size: '50-100', location: 'Berlin, DE', country: 'DE' },
  { name: 'Sunfield Agriculture', domain: 'sunfieldag.com.au', industry: 'Agriculture', size: '200-500', location: 'Melbourne, AU', country: 'AU' },
  { name: 'Ironbridge Construction', domain: 'ironbridge.co.uk', industry: 'Construction', size: '500-1000', location: 'Manchester, GB', country: 'GB' },
  { name: 'Solstice Media', domain: 'solsticemedia.fr', industry: 'Media', size: '100-200', location: 'Paris, FR', country: 'FR' },
  { name: 'Cascade Insurance', domain: 'cascadeins.com', industry: 'Insurance', size: '1000-5000', location: 'Seattle, US', country: 'US' },
  { name: 'Peregrine Travel', domain: 'peregrinetravel.sg', industry: 'Travel', size: '200-500', location: 'Singapore, SG', country: 'SG' },
  { name: 'Atlas Property', domain: 'atlasproperty.ae', industry: 'Real Estate', size: '100-200', location: 'Dubai, AE', country: 'AE' },
  { name: 'Verdant Foods', domain: 'verdantfoods.nl', industry: 'Food & Beverage', size: '500-1000', location: 'Amsterdam, NL', country: 'NL' },
  { name: 'Quarry Analytics', domain: 'quarryanalytics.com', industry: 'Software', size: '50-100', location: 'Denver, US', country: 'US' },
  { name: 'Beacon Telecom', domain: 'beacontelecom.ie', industry: 'Telecommunications', size: '1000-5000', location: 'Dublin, IE', country: 'IE' },
];

const TITLES = ['VP of Sales', 'Head of Revenue Operations', 'Sales Director', 'Chief Revenue Officer',
  'Sales Enablement Manager', 'Head of Inside Sales', 'Commercial Director', 'Sales Operations Lead',
  'Director of Business Development', 'Regional Sales Manager', 'Chief Operating Officer', 'Head of Customer Success'];

const SOURCES = ['inbound_form', 'outbound', 'referral', 'webinar', 'trade_show', 'partner', 'cold_call', 'linkedin', 'paid_ads', 'content'];
const PRODUCTS = ['SalesOS Platform', 'SalesOS Platform + Conversation Intelligence', 'SalesOS Enterprise', 'SalesOS Growth'];
const TAG_POOL = ['enterprise', 'mid-market', 'smb', 'expansion', 'renewal', 'competitive', 'security-review',
  'multi-region', 'champion-identified', 'budget-confirmed', 'inbound', 'high-intent'];

// --------------------------------------------------------------------------- //
function resetDatabase() {
  const file = config.db.file;
  if (file === ':memory:') return;
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${file}${suffix}`;
    if (fs.existsSync(target)) fs.rmSync(target);
  }
  const objects = config.storage.root;
  if (fs.existsSync(objects)) fs.rmSync(objects, { recursive: true, force: true });
  logger.info('database reset', { file });
}

function seedOrganization() {
  const orgId = id('org');
  insert('organizations', {
    id: orgId,
    name: 'Northstar Revenue',
    slug: 'northstar',
    plan: 'enterprise',
    seats: 25,
    currency: 'USD',
    timezone: 'America/New_York',
    settings: JSON.stringify({
      crmApproval: {
        mode: 'suggest',
        autoApplyConfidenceThreshold: 0.85,
        alwaysReviewSensitive: true,
        autoCreateTasks: false,
      },
      recording: { ...DEFAULT_ORG_SETTINGS.recording, retentionDays: 365 },
      quotas: { monthlyCallTarget: 420, monthlyRevenueTarget: 400000 },
    }),
    created_at: addDays(-420),
    updated_at: nowIso(),
  });
  return orgId;
}

function seedTeams(orgId) {
  const teams = [
    { name: 'Enterprise - North America', region: 'North America' },
    { name: 'Enterprise - EMEA', region: 'EMEA' },
    { name: 'Mid-Market', region: 'Global' },
  ].map((team) => {
    const row = {
      id: id('team'),
      organization_id: orgId,
      name: team.name,
      region: team.region,
      manager_id: null,
      created_at: addDays(-400),
      updated_at: nowIso(),
    };
    insert('teams', row);
    return row;
  });
  return teams;
}

function seedUsers(orgId, teams) {
  const password = hashPassword(config.seed.demoPassword);
  const definitions = [
    { name: 'Renata Alvarez', email: 'owner@northstar.demo', role: 'super_admin', title: 'Chief Revenue Officer', team: null, quota: 0 },
    { name: 'Samir Haddad', email: 'admin@northstar.demo', role: 'admin', title: 'Revenue Operations Lead', team: null, quota: 0 },
    { name: 'Claire Dubois', email: 'manager@northstar.demo', role: 'manager', title: 'Enterprise Sales Manager', team: 0, quota: 0 },
    { name: 'Peter Osei', email: 'manager.emea@northstar.demo', role: 'manager', title: 'EMEA Sales Manager', team: 1, quota: 0 },
    { name: 'Alex Nakamura', email: 'agent@northstar.demo', role: 'agent', title: 'Senior Account Executive', team: 0, quota: 120000 },
    { name: 'Bea Lindqvist', email: 'bea@northstar.demo', role: 'agent', title: 'Account Executive', team: 0, quota: 95000 },
    { name: 'Cyrus Malik', email: 'cyrus@northstar.demo', role: 'agent', title: 'Account Executive', team: 1, quota: 95000 },
    { name: 'Dalia Fischer', email: 'dalia@northstar.demo', role: 'agent', title: 'Enterprise AE', team: 1, quota: 140000 },
    { name: 'Eli Robinson', email: 'eli@northstar.demo', role: 'agent', title: 'Mid-Market AE', team: 2, quota: 70000 },
    { name: 'Farah Nassar', email: 'farah@northstar.demo', role: 'agent', title: 'Mid-Market AE', team: 2, quota: 70000 },
  ];
  const colors = ['#2f6df6', '#e2694a', '#3f9f7f', '#8b5cf6', '#d4a017', '#0ea5a4', '#db2777', '#4f46e5', '#16a34a', '#f97316'];

  const users = definitions.map((definition, index) => {
    const row = {
      id: id('user'),
      organization_id: orgId,
      email: definition.email,
      name: definition.name,
      password_hash: password,
      role: definition.role,
      team_id: definition.team === null ? null : teams[definition.team].id,
      title: definition.title,
      phone: toE164(`+1555010${String(index).padStart(2, '0')}`),
      avatar_color: colors[index % colors.length],
      timezone: definition.team === 1 ? 'Europe/Berlin' : 'America/New_York',
      quota_amount: definition.quota,
      status: 'active',
      preferences: JSON.stringify({ theme: 'system', density: 'comfortable' }),
      last_login_at: addHours(-int(1, 40)),
      created_at: addDays(-int(200, 400)),
      updated_at: nowIso(),
    };
    insert('users', row);
    return row;
  });

  // Wire managers to their teams.
  run('UPDATE teams SET manager_id = ? WHERE id = ?', [users[2].id, teams[0].id]);
  run('UPDATE teams SET manager_id = ? WHERE id = ?', [users[3].id, teams[1].id]);
  run('UPDATE teams SET manager_id = ? WHERE id = ?', [users[2].id, teams[2].id]);
  return users;
}

function seedConfiguration(orgId, users, teams) {
  const customFields = [
    { entity: 'lead', key: 'crm_in_use', label: 'Current CRM', type: 'select', options: ['Salesforce', 'HubSpot', 'Pipedrive', 'Spreadsheets', 'None'], ai: 1, hint: 'The CRM the prospect uses today, if mentioned' },
    { entity: 'lead', key: 'team_size', label: 'Sales team size', type: 'number', ai: 1, hint: 'Number of sales reps or seats discussed' },
    { entity: 'deal', key: 'security_review', label: 'Security review required', type: 'boolean', ai: 1, hint: 'True when a security or compliance review is a gating step' },
    { entity: 'deal', key: 'procurement_stage', label: 'Procurement stage', type: 'select', options: ['not_started', 'legal_review', 'security_review', 'signature'], ai: 1, hint: 'Where the paperwork currently sits' },
    { entity: 'company', key: 'parent_group', label: 'Parent group', type: 'text', ai: 0 },
  ];
  customFields.forEach((field, index) => {
    insert('custom_field_defs', {
      id: id('cfd'),
      organization_id: orgId,
      entity_type: field.entity,
      key: field.key,
      label: field.label,
      type: field.type,
      options: JSON.stringify(field.options || []),
      required: 0,
      ai_extractable: field.ai,
      ai_hint: field.hint || null,
      position: index * 10,
      created_at: addDays(-300),
    });
  });

  const rules = [
    { name: 'Enterprise inbound to North America team', priority: 10, conditions: [{ field: 'source', op: 'equals', value: 'inbound_form' }, { field: 'dealValue', op: 'gte', value: 50000 }], strategy: 'team_load', team: 0 },
    { name: 'EMEA leads to EMEA team', priority: 20, conditions: [{ field: 'country', op: 'in', value: 'DE,GB,FR,NL,NO,IE,SE' }], strategy: 'round_robin', team: 1 },
    { name: 'Referrals to the senior AE', priority: 30, conditions: [{ field: 'source', op: 'equals', value: 'referral' }], strategy: 'specific_user', user: 4 },
    { name: 'Everything else round-robin', priority: 900, conditions: [], strategy: 'round_robin', team: null },
  ];
  rules.forEach((rule) => {
    insert('assignment_rules', {
      id: id('asr'),
      organization_id: orgId,
      name: rule.name,
      priority: rule.priority,
      conditions: JSON.stringify(rule.conditions),
      strategy: rule.strategy,
      target_user_id: rule.user !== undefined ? users[rule.user].id : null,
      target_team_id: rule.team !== null && rule.team !== undefined ? teams[rule.team].id : null,
      enabled: 1,
      cursor: 0,
      created_at: addDays(-300),
      updated_at: nowIso(),
    });
  });

  for (const integration of [
    { provider: 'twilio', category: 'telephony', status: 'connected', config: { callerId: '+15550100', recordingEnabled: true } },
    { provider: 'google_mail', category: 'email', status: 'connected', config: { domain: 'northstar.demo' } },
    { provider: 'google_calendar', category: 'calendar', status: 'connected', config: { calendarId: 'primary' } },
    { provider: 'slack', category: 'chat', status: 'connected', config: { channel: '#revenue-alerts' } },
    { provider: 'salesforce', category: 'crm', status: 'disconnected', config: {} },
    { provider: 'stripe', category: 'payments', status: 'connected', config: { plan: 'enterprise' } },
  ]) {
    insert('integrations', {
      id: id('int'),
      organization_id: orgId,
      provider: integration.provider,
      category: integration.category,
      status: integration.status,
      config: JSON.stringify(integration.config),
      credentials_enc: null,
      last_sync_at: integration.status === 'connected' ? addHours(-int(1, 12)) : null,
      created_at: addDays(-250),
      updated_at: nowIso(),
    });
  }
}

function seedCompaniesAndLeads(orgId, users) {
  const agents = users.filter((u) => u.role === 'agent');
  const companies = COMPANIES.map((company) => {
    const row = {
      id: id('cmp'),
      organization_id: orgId,
      name: company.name,
      domain: company.domain,
      industry: company.industry,
      size: company.size,
      location: company.location,
      annual_revenue: int(20, 900) * 1000000,
      notes: null,
      created_at: addDays(-int(90, 380)),
      updated_at: nowIso(),
    };
    insert('companies', row);
    return { ...row, country: company.country };
  });

  const leads = [];
  const statusWeights = [
    ['new', 0.18], ['contacted', 0.24], ['qualified', 0.26], ['customer', 0.12], ['unqualified', 0.1], ['lost', 0.1],
  ];
  const pickStatus = () => {
    const roll = rand();
    let cumulative = 0;
    for (const [status, weight] of statusWeights) {
      cumulative += weight;
      if (roll <= cumulative) return status;
    }
    return 'contacted';
  };

  for (let i = 0; i < 64; i += 1) {
    const company = companies[i % companies.length];
    const firstName = FIRST_NAMES[i % FIRST_NAMES.length];
    const lastName = LAST_NAMES[(i * 7) % LAST_NAMES.length];
    const status = pickStatus();
    const owner = pick(agents);
    const createdAt = addDays(-int(2, 180));
    const contacted = !['new'].includes(status);
    const temperature = status === 'qualified' ? (chance(0.55) ? 'hot' : 'warm')
      : status === 'contacted' ? (chance(0.35) ? 'warm' : 'cold')
        : status === 'customer' ? 'hot' : 'cold';
    const score = temperature === 'hot' ? int(68, 94) : temperature === 'warm' ? int(42, 70) : int(8, 45);
    const dealValue = chance(0.75) ? int(8, 180) * 1000 : 0;

    const row = {
      id: id('lead'),
      organization_id: orgId,
      company_id: company.id,
      first_name: firstName,
      last_name: lastName,
      company_name: company.name,
      job_title: pick(TITLES),
      phone: `+1 555 0${String(200 + i).slice(0, 3)} ${String(1000 + i * 7).slice(0, 4)}`,
      phone_e164: toE164(`+1555${String(2000000 + i * 137).slice(0, 7)}`),
      secondary_phone: null,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${company.domain}`,
      location: company.location,
      country: company.country,
      timezone: null,
      source: pick(SOURCES),
      industry: company.industry,
      status,
      temperature,
      score,
      tags: JSON.stringify(pickN(TAG_POOL, int(0, 3))),
      owner_id: owner.id,
      deal_value: dealValue,
      expected_close_date: dealValue ? addDays(int(5, 120)) : null,
      next_follow_up_at: contacted && chance(0.55) ? addDays(int(-4, 14)) : null,
      last_contacted_at: contacted ? addDays(-int(1, 45)) : null,
      first_response_seconds: contacted ? int(180, 90000) : null,
      do_not_call: chance(0.03) ? 1 : 0,
      consent_recording: chance(0.5) ? 'granted' : 'unknown',
      custom_fields: JSON.stringify({
        crm_in_use: pick(['Salesforce', 'HubSpot', 'Spreadsheets', 'Pipedrive', 'None']),
        team_size: int(8, 220),
      }),
      ai_snapshot: '{}',
      dedupe_key: `email:${firstName.toLowerCase()}.${lastName.toLowerCase()}@${company.domain}`,
      created_by: owner.id,
      created_at: createdAt,
      updated_at: nowIso(),
    };
    insert('leads', row);
    leads.push(row);

    activityService.log({
      organizationId: orgId,
      leadId: row.id,
      actorId: owner.id,
      type: 'lead_created',
      refId: row.id,
      title: `Lead created: ${firstName} ${lastName}`,
      metadata: { source: row.source, assignedTo: owner.id },
      occurredAt: createdAt,
      broadcast: false,
    });
  }
  return { companies, leads };
}

function seedDeals(orgId, leads) {
  const deals = [];
  const stageWeights = [
    ['new_lead', 0.1], ['contacted', 0.13], ['qualified', 0.15], ['discovery', 0.13],
    ['demo', 0.12], ['proposal', 0.12], ['negotiation', 0.08], ['won', 0.1], ['lost', 0.07],
  ];
  const pickStage = () => {
    const roll = rand();
    let cumulative = 0;
    for (const [stage, weight] of stageWeights) {
      cumulative += weight;
      if (roll <= cumulative) return stage;
    }
    return 'qualified';
  };

  const LOST_REASONS = ['Price above approved budget', 'Chose an incumbent competitor', 'Project deprioritised',
    'No budget this fiscal year', 'Lost champion to a role change', 'Missing a required integration'];

  for (const lead of leads) {
    if (!lead.deal_value || ['unqualified'].includes(lead.status)) continue;
    const stage = lead.status === 'customer' ? 'won' : lead.status === 'lost' ? 'lost' : pickStage();
    const enteredAt = addDays(-int(1, 70));
    const value = lead.deal_value || int(10, 150) * 1000;

    const row = {
      id: id('deal'),
      organization_id: orgId,
      lead_id: lead.id,
      company_id: lead.company_id,
      name: `${lead.company_name} - ${pick(PRODUCTS)}`,
      stage,
      value,
      currency: 'USD',
      probability: STAGE_MAP[stage].probability,
      expected_close_date: ['won', 'lost'].includes(stage) ? addDays(-int(1, 40)) : addDays(int(3, 110)),
      owner_id: lead.owner_id,
      product: pick(PRODUCTS),
      competitors: JSON.stringify(chance(0.45) ? pickN(['Salesloft', 'Outreach', 'Gong', 'HubSpot', 'Chorus'], int(1, 2)) : []),
      pain_points: JSON.stringify(pickN([
        'reps lose an hour a day to CRM admin',
        'call notes are too inconsistent to coach from',
        'follow-ups are missed once a rep passes forty open deals',
        'no visibility into which objections cost deals',
      ], int(1, 3))),
      requirements: JSON.stringify(pickN([
        'single sign-on with Okta',
        'two-party consent recording controls',
        'Salesforce two-way sync',
        'EU data residency',
        'role-based access for reps',
      ], int(1, 3))),
      decision_maker: chance(0.6) ? `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}, ${pick(['CRO', 'VP of Sales', 'CFO', 'COO'])}` : null,
      budget: chance(0.55) ? Math.round(value * (0.8 + rand() * 0.4) / 1000) * 1000 : null,
      timeline: chance(0.6) ? pick(['4 weeks', '6 weeks', 'this quarter', 'next quarter', '8 weeks']) : null,
      risk_score: 0,
      risk_reasons: '[]',
      health: 'unknown',
      stage_entered_at: enteredAt,
      closed_at: ['won', 'lost'].includes(stage) ? addDays(-int(1, 40)) : null,
      lost_reason: stage === 'lost' ? pick(LOST_REASONS) : null,
      position: deals.length + 1,
      custom_fields: JSON.stringify({
        security_review: chance(0.4),
        procurement_stage: pick(['not_started', 'legal_review', 'security_review', 'signature']),
      }),
      created_at: addDays(-int(20, 150)),
      updated_at: nowIso(),
    };
    insert('deals', row);
    deals.push(row);

    // Stage history, so velocity and funnel reports have real transitions.
    const order = ['new_lead', 'contacted', 'qualified', 'discovery', 'demo', 'proposal', 'negotiation'];
    const targetIndex = ['won', 'lost'].includes(stage) ? order.length : order.indexOf(stage);
    let cursor = new Date(row.created_at);
    let previous = null;
    for (let i = 0; i <= Math.max(0, targetIndex); i += 1) {
      const to = i < order.length ? order[i] : stage;
      insert('deal_stage_history', {
        id: id('dsh'),
        organization_id: orgId,
        deal_id: row.id,
        from_stage: previous,
        to_stage: to,
        changed_by: lead.owner_id,
        source: chance(0.25) ? 'ai' : 'user',
        created_at: cursor.toISOString(),
      });
      previous = to;
      cursor = new Date(cursor.getTime() + int(2, 12) * 86400000);
      if (cursor > new Date()) break;
    }
  }
  return deals;
}

async function seedCallsAndPipeline(orgId, leads, deals, users) {
  const agents = users.filter((u) => u.role === 'agent');
  // The primary demo account must land on a populated approval queue -- that
  // screen is the point of the product, and suggestions are owner-scoped.
  const demoAgentId = users.find((u) => u.email === 'agent@northstar.demo')?.id;
  const dealByLead = new Map(deals.map((d) => [d.lead_id, d]));
  const contactable = leads.filter((l) => l.last_contacted_at);
  const created = { calls: 0, analysed: 0, suggestions: 0 };

  for (const [index, lead] of contactable.entries()) {
    const callCount = int(1, 3);
    for (let n = 0; n < callCount; n += 1) {
      const agent = agents.find((a) => a.id === lead.owner_id) || pick(agents);
      const startedAt = addDays(-int(1, 40), new Date(lead.last_contacted_at));
      const connected = chance(0.68);
      const status = connected ? 'completed' : pick(['no_answer', 'voicemail', 'missed']);
      const duration = connected ? int(240, 1500) : int(8, 40);
      const talk = connected ? duration - int(5, 40) : 0;
      const recordingEnabled = connected && lead.consent_recording === 'granted';
      const deal = dealByLead.get(lead.id);

      const call = {
        id: id('call'),
        organization_id: orgId,
        lead_id: lead.id,
        deal_id: deal?.id || null,
        agent_id: agent.id,
        provider: 'simulator',
        provider_call_id: id('simcall'),
        direction: chance(0.8) ? 'outbound' : 'inbound',
        from_number: agent.phone,
        to_number: lead.phone_e164,
        masked_number: lead.phone_e164,
        country_code: '1',
        status,
        outcome: connected ? (chance(0.2) ? 'meeting_booked' : 'connected') : status === 'voicemail' ? 'voicemail' : 'no_answer',
        started_at: startedAt,
        answered_at: connected ? addMinutes(0.1, new Date(startedAt)) : null,
        ended_at: new Date(new Date(startedAt).getTime() + duration * 1000).toISOString(),
        duration_seconds: duration,
        talk_seconds: talk,
        hold_seconds: connected && chance(0.2) ? int(10, 90) : 0,
        recording_enabled: recordingEnabled ? 1 : 0,
        recording_consent: recordingEnabled ? 'granted' : 'not_required',
        consent_method: recordingEnabled ? 'verbal' : 'policy',
        notes: connected && chance(0.4) ? pick([
          'Champion is engaged, needs to bring in the CFO.',
          'Asked for a phased rollout option.',
          'Security review is the gating item.',
          'Wants a regional reporting example before the next call.',
        ]) : null,
        tags: '[]',
        ai_status: 'none',
        created_at: startedAt,
        updated_at: startedAt,
      };
      insert('calls', call);
      created.calls += 1;

      insert('call_events', {
        id: id('cev'),
        organization_id: orgId,
        call_id: call.id,
        type: 'dial',
        payload: JSON.stringify({ to: lead.phone_e164, seeded: true }),
        created_at: startedAt,
      });

      activityService.log({
        organizationId: orgId,
        leadId: lead.id,
        dealId: deal?.id || null,
        actorId: agent.id,
        type: 'call',
        refId: call.id,
        title: `${call.direction === 'inbound' ? 'Inbound' : 'Outbound'} call - ${call.outcome.replace(/_/g, ' ')}`,
        body: call.notes,
        metadata: { durationSeconds: duration, talkSeconds: talk, status },
        occurredAt: startedAt,
        broadcast: false,
      });

      // Run the genuine pipeline for connected, recorded, substantial calls.
      if (recordingEnabled && talk > 120) {
        const { transcript } = await ai.transcribeCall({ call, lead, deal, agentName: agent.name });
        const { analysis } = await ai.analyseCall({
          call, transcript, lead, deal, agentName: agent.name, customFields: [],
        });
        run(`UPDATE calls SET ai_status = 'complete' WHERE id = ?`, [call.id]);
        created.analysed += 1;

        const candidates = extraction.buildSuggestions({ analysis, lead, deal, callDate: call.started_at });
        // Only the most recent call per lead leaves suggestions pending, so the
        // review queue reads as a working inbox rather than a backlog. Every
        // lead owned by the demo agent keeps one, so their queue is never empty.
        const isLatest = n === callCount - 1
          && (lead.owner_id === demoAgentId || index % 4 === 0);
        const result = extraction.persistSuggestions({
          organizationId: orgId,
          sourceType: 'call',
          sourceId: call.id,
          candidates,
          actorId: null,
          notifyUserId: null,
        });
        created.suggestions += result.suggestions.length;
        if (!isLatest) {
          // Historic batches are resolved so the audit trail shows real decisions.
          for (const suggestion of result.suggestions) {
            if (chance(0.75)) {
              try {
                extraction.decide({
                  organizationId: orgId,
                  suggestionId: suggestion.id,
                  action: 'approve',
                  actorId: agent.id,
                });
              } catch {
                // A superseded or conflicting suggestion is fine to skip.
              }
            } else {
              extraction.decide({
                organizationId: orgId, suggestionId: suggestion.id, action: 'reject', actorId: agent.id,
              });
            }
          }
        }

        activityService.log({
          organizationId: orgId,
          leadId: lead.id,
          dealId: deal?.id || null,
          actorType: 'ai',
          type: 'ai_insight',
          refId: call.id,
          title: 'AI analysed the call',
          body: analysis.summary,
          metadata: {
            callId: call.id,
            sentiment: analysis.sentiment,
            objections: (analysis.objections || []).length,
            buyingSignals: (analysis.buying_signals || []).length,
            score: analysis.scorecard?.overall ?? null,
          },
          occurredAt: call.ended_at,
          broadcast: false,
        });
      }
    }
  }
  return created;
}

function seedEngagement(orgId, leads, deals, users) {
  const agents = users.filter((u) => u.role === 'agent');
  const dealByLead = new Map(deals.map((d) => [d.lead_id, d]));
  let tasks = 0;
  let emails = 0;
  let meetings = 0;
  let notes = 0;

  for (const lead of leads) {
    const owner = users.find((u) => u.id === lead.owner_id) || pick(agents);
    const deal = dealByLead.get(lead.id);

    if (lead.last_contacted_at && chance(0.7)) {
      const dueAt = chance(0.4) ? addDays(-int(1, 6)) : nextBusinessSlot(int(1, 12));
      const aiSourced = chance(0.45);
      insert('tasks', {
        id: id('tsk'),
        organization_id: orgId,
        lead_id: lead.id,
        deal_id: deal?.id || null,
        call_id: null,
        assignee_id: owner.id,
        created_by: aiSourced ? null : owner.id,
        title: pick([
          `Follow up with ${lead.first_name} on the proposal`,
          `Send ${lead.first_name} the security pack`,
          `Book the technical deep-dive with ${lead.company_name}`,
          `Confirm budget owner at ${lead.company_name}`,
          `Share the phased rollout option with ${lead.first_name}`,
        ]),
        description: null,
        type: pick(['call', 'email', 'follow_up', 'demo', 'proposal']),
        priority: lead.temperature === 'hot' ? pick(['high', 'urgent']) : pick(['medium', 'low']),
        status: chance(0.35) ? 'done' : 'open',
        due_at: dueAt,
        completed_at: null,
        source: aiSourced ? 'ai' : 'user',
        ai_reason: aiSourced ? 'Extracted from the last call: the customer asked for this before the next step.' : null,
        reminder_at: addMinutes(-30, new Date(dueAt)),
        created_at: addDays(-int(1, 20)),
        updated_at: nowIso(),
      });
      tasks += 1;
    }

    if (lead.last_contacted_at && chance(0.6)) {
      const aiGenerated = chance(0.65);
      const sentAt = addDays(-int(1, 30));
      insert('emails', {
        id: id('eml'),
        organization_id: orgId,
        lead_id: lead.id,
        deal_id: deal?.id || null,
        call_id: null,
        user_id: owner.id,
        direction: 'outbound',
        template: pick(['thank_you', 'follow_up', 'proposal_follow_up', 'product_information', 're_engagement']),
        to_address: lead.email,
        cc: '[]',
        subject: pick([
          `Thanks for your time, ${lead.first_name}`,
          `Following up - ${lead.company_name}`,
          `Proposal - ${lead.company_name}`,
          `The detail you asked for`,
        ]),
        body: `Hi ${lead.first_name},\n\nThanks for the conversation. As agreed, I have attached the detail we discussed and will follow up on the timeline you mentioned.\n\n${owner.name}`,
        body_format: 'text',
        status: chance(0.9) ? 'sent' : 'draft',
        generated_by_ai: aiGenerated ? 1 : 0,
        ai_metadata: JSON.stringify(aiGenerated ? { provider: 'local', model: 'local-template' } : {}),
        edited_by_human: aiGenerated && chance(0.6) ? 1 : 0,
        provider: 'log',
        provider_message_id: id('msg'),
        opened_at: chance(0.55) ? addHours(-int(1, 200)) : null,
        replied_at: chance(0.25) ? addHours(-int(1, 150)) : null,
        sent_at: sentAt,
        created_at: sentAt,
        updated_at: sentAt,
      });
      emails += 1;
    }

    if (deal && !['won', 'lost'].includes(deal.stage) && chance(0.4)) {
      const startsAt = chance(0.6) ? addDays(int(1, 12)) : addDays(-int(1, 20));
      insert('meetings', {
        id: id('mtg'),
        organization_id: orgId,
        lead_id: lead.id,
        deal_id: deal.id,
        organizer_id: owner.id,
        title: pick([`${lead.company_name} - product deep dive`, `${lead.company_name} - commercial review`, `Demo: ${lead.company_name}`]),
        description: 'Agenda: recap requirements, walk through the workflow, agree next steps.',
        type: pick(['demo', 'discovery', 'follow_up', 'meeting']),
        location: 'Video call',
        conference_url: `https://meet.northstar.demo/${id('room')}`,
        starts_at: startsAt,
        ends_at: addMinutes(45, new Date(startsAt)),
        timezone: 'UTC',
        attendees: JSON.stringify([{ email: lead.email, name: `${lead.first_name} ${lead.last_name}`, role: 'contact' }]),
        status: new Date(startsAt) < new Date() ? pick(['held', 'held', 'no_show']) : 'scheduled',
        reminder_minutes: 15,
        reminder_sent_at: null,
        invite_sent_at: startsAt,
        ai_suggested: chance(0.3) ? 1 : 0,
        created_at: addDays(-int(1, 25)),
        updated_at: nowIso(),
      });
      meetings += 1;
    }

    if (chance(0.45)) {
      insert('notes', {
        id: id('note'),
        organization_id: orgId,
        lead_id: lead.id,
        deal_id: deal?.id || null,
        call_id: null,
        author_id: owner.id,
        body: pick([
          'Prefers email over phone. Responds fastest in the morning.',
          'Champion, but cannot sign alone. CFO approves anything over 25k.',
          'Had a bad experience with a previous vendor migration - be explicit about onboarding.',
          'Reporting by region is the deciding feature for this account.',
          'Quiet through August, planning cycle restarts in September.',
        ]),
        pinned: chance(0.2) ? 1 : 0,
        source: 'user',
        created_at: addDays(-int(1, 60)),
        updated_at: nowIso(),
      });
      notes += 1;
    }
  }
  return { tasks, emails, meetings, notes };
}

function seedNotifications(orgId, users, leads) {
  const agents = users.filter((u) => u.role === 'agent');
  let count = 0;
  for (const agent of agents) {
    const ownLeads = leads.filter((l) => l.owner_id === agent.id).slice(0, 4);
    for (const lead of ownLeads) {
      insert('notifications', {
        id: id('ntf'),
        organization_id: orgId,
        user_id: agent.id,
        type: pick(['ai_recommendation', 'follow_up', 'new_lead', 'approval_required']),
        title: pick([
          `${lead.first_name} ${lead.last_name} is going cold - no contact in 9 days`,
          `Follow-up due today: ${lead.company_name}`,
          `New lead assigned: ${lead.first_name} ${lead.last_name}`,
          `CRM updates ready for review from your call with ${lead.first_name}`,
        ]),
        body: lead.company_name,
        priority: lead.temperature === 'hot' ? 'high' : 'normal',
        entity_type: 'lead',
        entity_id: lead.id,
        link: `/leads/${lead.id}`,
        channels: '["in_app"]',
        read_at: chance(0.5) ? addHours(-int(1, 20)) : null,
        created_at: addHours(-int(1, 60)),
      });
      count += 1;
    }
  }
  return count;
}

function seedWebhook(orgId, users) {
  insert('webhooks', {
    id: id('whk'),
    organization_id: orgId,
    url: 'https://hooks.northstar.demo/salesos',
    events: JSON.stringify(['deal.stage_changed', 'deal.won', 'analysis.ready', 'lead.created']),
    secret: id('sec'),
    enabled: 1,
    failure_count: 0,
    last_status: 200,
    last_delivered_at: addHours(-3),
    created_at: addDays(-40),
  });
}

// --------------------------------------------------------------------------- //
export async function seed({ reset = false } = {}) {
  if (reset) resetDatabase();
  const db = getDb();
  migrate(db);

  const existing = get('SELECT COUNT(*) AS n FROM organizations')?.n || 0;
  if (existing && !reset) {
    logger.warn('database already contains data; run with --reset to rebuild');
    return { skipped: true };
  }

  const startedAt = Date.now();
  const orgId = seedOrganization();
  const teams = seedTeams(orgId);
  const users = seedUsers(orgId, teams);
  seedConfiguration(orgId, users, teams);
  const { companies, leads } = seedCompaniesAndLeads(orgId, users);
  const deals = seedDeals(orgId, leads);
  const pipeline = await seedCallsAndPipeline(orgId, leads, deals, users);
  const engagement = seedEngagement(orgId, leads, deals, users);
  const notifications = seedNotifications(orgId, users, leads);
  seedWebhook(orgId, users);
  invalidate(orgId);
  const indexed = reindexOrganization(orgId);

  const summary = {
    organization: orgId,
    teams: teams.length,
    users: users.length,
    companies: companies.length,
    leads: leads.length,
    deals: deals.length,
    ...pipeline,
    ...engagement,
    notifications,
    searchRecords: indexed,
    pendingSuggestions: get(`SELECT COUNT(*) AS n FROM ai_suggestions WHERE status = 'pending'`)?.n || 0,
    auditEntries: get('SELECT COUNT(*) AS n FROM audit_logs')?.n || 0,
    durationMs: Date.now() - startedAt,
  };
  logger.info('seed complete', summary);
  return summary;
}

// Run directly: `npm run seed` / `npm run reset`
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('db', 'seed.js'));
if (invokedDirectly) {
  const reset = process.argv.includes('--reset');
  seed({ reset })
    .then((summary) => {
      if (!summary.skipped) {
        process.stdout.write(`\nSeeded SalesOS demo data:\n${JSON.stringify(summary, null, 2)}\n\n`);
        process.stdout.write('Sign in with any of:\n');
        for (const account of [
          ['owner@northstar.demo', 'Super Admin'],
          ['admin@northstar.demo', 'Admin'],
          ['manager@northstar.demo', 'Sales Manager'],
          ['agent@northstar.demo', 'Sales Agent'],
        ]) {
          process.stdout.write(`  ${account[0].padEnd(32)} ${account[1].padEnd(16)} password: ${config.seed.demoPassword}\n`);
        }
        process.stdout.write('\n');
      }
      closeDb();
      process.exit(0);
    })
    .catch((error) => {
      logger.error('seed failed', { message: error.message, stack: error.stack });
      process.exit(1);
    });
}

export default seed;
