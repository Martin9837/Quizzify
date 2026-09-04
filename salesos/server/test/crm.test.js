import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, login, ACCOUNTS } from './helpers.js';

before(start);
after(stop);

describe('lead management', () => {
  it('creates a lead, normalises the phone number and assigns an owner', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const result = await api.post('/leads', {
      firstName: 'Testcase',
      lastName: 'Contact',
      companyName: 'Assertive Systems',
      phone: '(555) 987 6543',
      email: 'testcase.contact@assertive.test',
      source: 'referral',
      jobTitle: 'VP of Sales',
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.lead.phone, '+15559876543', 'phone should be normalised to E.164');
    assert.ok(result.body.lead.ownerId, 'assignment rules should pick an owner');
    assert.ok(result.body.lead.score > 20, 'a referral from a VP should score above the baseline');
  });

  it('detects duplicates by email', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const payload = {
      firstName: 'Duplicate',
      lastName: 'Person',
      email: 'duplicate.person@assertive.test',
      phone: '+15551110000',
    };
    const first = await api.post('/leads', payload);
    assert.equal(first.status, 201);

    const second = await api.post('/leads', payload);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.details.duplicateOf, first.body.lead.id);
    assert.equal(second.body.error.details.matchedOn, 'email');

    const check = await api.post('/leads/check-duplicate', { email: payload.email });
    assert.ok(check.body.duplicate, 'the duplicate check endpoint should find it too');
  });

  it('imports a CSV with loose headers and keeps unknown columns as custom fields', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const csv = [
      'Full Name,Organisation,Work Email,Mobile,Lead Source,Contract Vehicle',
      'Ada Lovelace,Analytical Engines,ada@analytical.test,+15552223333,webinar,GSA',
      'Grace Hopper,Compiler Works,grace@compilers.test,+15554445555,referral,SEWP',
      ',,,,,',
      'Broken Row,No Contact Details,,,outbound,',
    ].join('\n');

    const preview = await api.post('/leads/import/preview', { csv });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.totalRows, 3, 'the blank row should be dropped');
    assert.ok(preview.body.sample.some((row) => row.problems.length > 0), 'the invalid row should be flagged');

    const result = await api.post('/leads/import', { csv });
    assert.equal(result.status, 200);
    assert.equal(result.body.created, 2);
    assert.equal(result.body.errors.length, 1, 'the row with no email or phone should be rejected');

    const found = await api.get('/leads?q=Lovelace');
    const ada = found.body.leads[0];
    assert.equal(ada.name, 'Ada Lovelace');
    assert.equal(ada.companyName, 'Analytical Engines');
    assert.equal(ada.customFields.contract_vehicle, 'GSA', 'unmapped columns become custom fields');
  });

  it('records an audit entry and a timeline event for every field change', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const lead = (await api.get('/leads?limit=1')).body.leads[0];

    await api.patch(`/leads/${lead.id}`, { temperature: 'hot', status: 'qualified' });

    const audit = await api.get(`/leads/${lead.id}/audit`);
    const update = audit.body.audit.find((entry) => entry.action === 'lead.update');
    assert.ok(update, 'an audit entry should exist');
    assert.equal(update.diff.temperature.to, 'hot');

    const timeline = await api.get(`/leads/${lead.id}/timeline`);
    assert.ok(timeline.body.timeline.some((item) => item.type === 'crm_change'));
  });

  it('applies bulk actions', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const leads = (await api.get('/leads?limit=3')).body.leads;
    const ids = leads.map((lead) => lead.id);

    const tagged = await api.post('/leads/bulk', { leadIds: ids, action: 'tag', tags: ['bulk-test'] });
    assert.equal(tagged.status, 200);
    assert.equal(tagged.body.updated, ids.length);

    const filtered = await api.get('/leads?tag=bulk-test');
    assert.equal(filtered.body.leads.length, ids.length);
  });
});

describe('deals and pipeline', () => {
  it('moves a deal, records history and updates probability', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const pipeline = await api.get('/deals/pipeline');
    const openDeal = pipeline.body.stages
      .filter((stage) => !stage.terminal)
      .flatMap((stage) => stage.deals)
      .find((deal) => deal.stage !== 'proposal');
    assert.ok(openDeal, 'seed data should contain an open deal');

    const moved = await api.post(`/deals/${openDeal.id}/move`, { stage: 'proposal' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.deal.stage, 'proposal');
    assert.equal(moved.body.deal.probability, 70, 'probability should follow the stage');

    const detail = await api.get(`/deals/${openDeal.id}`);
    assert.ok(detail.body.stageHistory.some((entry) => entry.to_stage === 'proposal'));
  });

  it('requires a lost reason before a deal can be marked lost', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const created = await api.post('/deals', { name: 'Lost reason test', value: 1000, stage: 'qualified' });
    const withoutReason = await api.post(`/deals/${created.body.deal.id}/move`, { stage: 'lost' });
    assert.equal(withoutReason.status, 422);
    assert.equal(withoutReason.body.error.code, 'lost_reason_required');

    const withReason = await api.post(`/deals/${created.body.deal.id}/move`, {
      stage: 'lost',
      lostReason: 'Budget cut',
    });
    assert.equal(withReason.status, 200);
    assert.equal(withReason.body.deal.lostReason, 'Budget cut');
  });

  it('reports pipeline totals that match the stage contents', async () => {
    const { api } = await login(ACCOUNTS.manager);
    const { body } = await api.get('/deals/pipeline');
    const openStages = body.stages.filter((stage) => !stage.terminal);
    const summed = openStages.reduce((total, stage) => total + stage.value, 0);
    assert.equal(Math.round(summed), Math.round(body.totals.openValue));
  });
});

describe('a caller-supplied id that does not exist', () => {
  // These fields are ids the client sends: a typo, a stale id from a cached
  // page, or a deleted record all produce a well-formed value that no longer
  // resolves. Every one of them used to reach SQLite and come back as an
  // unhandled FOREIGN KEY constraint failure, which the error handler could
  // only report as a 500 -- blaming the server for the client's own input and
  // logging a stack trace for something that is not a defect.
  const GHOST_USER = 'user_ghost000000';
  const GHOST_LEAD = 'lead_ghost000000';
  const GHOST_TEAM = 'team_ghost000000';

  const isClientError = (status) => status >= 400 && status < 500;

  it('is a client error when creating a lead with an unknown owner', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const { status } = await api.post('/leads', {
      firstName: 'Ghost', lastName: 'Owner', email: 'ghost.owner@example.com', ownerId: GHOST_USER,
    });
    assert.ok(isClientError(status), `expected 4xx, got ${status}`);
  });

  it('is a client error when reassigning a lead to an unknown owner', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const lead = (await api.get('/leads?limit=1')).body.leads[0];
    const { status } = await api.patch(`/leads/${lead.id}`, { ownerId: GHOST_USER });
    assert.ok(isClientError(status), `expected 4xx, got ${status}`);
  });

  it('is a client error when creating a deal with an unknown owner', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const lead = (await api.get('/leads?limit=1')).body.leads[0];
    const { status } = await api.post('/deals', {
      name: 'Ghost Owner Deal', leadId: lead.id, ownerId: GHOST_USER, stage: 'qualified', value: 1000,
    });
    assert.ok(isClientError(status), `expected 4xx, got ${status}`);
  });

  it('is a client error when creating a task against an unknown lead', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const { status } = await api.post('/tasks', {
      title: 'Ghost Lead Task', leadId: GHOST_LEAD, dueAt: '2027-01-01T00:00:00Z',
    });
    assert.ok(isClientError(status), `expected 4xx, got ${status}`);
  });

  it('is a client error when creating a user on an unknown team', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const { status } = await api.post('/admin/users', {
      name: 'Ghost Team User', email: 'ghost.team@example.com', role: 'agent', teamId: GHOST_TEAM,
    });
    assert.ok(isClientError(status), `expected 4xx, got ${status}`);
  });

  it('still succeeds with a real owner, so the guard is not over-broad', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const me = (await api.get('/auth/me')).body;
    const ownerId = me.user?.id ?? me.id;
    const { status } = await api.post('/leads', {
      firstName: 'Real', lastName: 'Owner', email: 'real.owner@example.com', ownerId,
    });
    assert.equal(status, 201);
  });
});
