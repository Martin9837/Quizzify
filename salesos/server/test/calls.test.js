import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, login, ACCOUNTS } from './helpers.js';
import { drain } from '../src/services/queue/index.js';

before(start);
after(stop);

describe('calling', () => {
  it('places a call, associates it with the CRM record and masks the number', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const lead = (await api.get('/leads?limit=20')).body.leads.find((entry) => entry.phone && !entry.doNotCall);
    assert.ok(lead, 'need a callable lead');

    const result = await api.post('/calls', { leadId: lead.id });
    assert.equal(result.status, 201);
    assert.equal(result.body.call.leadId, lead.id);
    assert.ok(result.body.call.maskedNumber.includes('*'), 'the number should be masked for display');
    assert.ok(result.body.consent.mode, 'a consent policy should be resolved before dialling');
    assert.ok(result.body.context, 'the CRM context for the call screen should be returned');
  });

  it('runs the full control surface and ends the call with a disposition', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const lead = (await api.get('/leads?limit=20')).body.leads.find((entry) => entry.phone && !entry.doNotCall);
    const { body } = await api.post('/calls', { leadId: lead.id });
    const callId = body.call.id;

    assert.equal((await api.post(`/calls/${callId}/answer`)).status, 200);
    assert.equal((await api.post(`/calls/${callId}/mute`, { muted: true })).body.call.muted, true);
    assert.equal((await api.post(`/calls/${callId}/hold`, { onHold: true })).body.call.onHold, true);
    assert.equal((await api.post(`/calls/${callId}/hold`, { onHold: false })).body.call.onHold, false);
    assert.equal((await api.post(`/calls/${callId}/dtmf`, { digits: '123#' })).status, 200);

    const ended = await api.post(`/calls/${callId}/end`, { outcome: 'connected', notes: 'Great conversation.' });
    assert.equal(ended.status, 200);
    assert.equal(ended.body.call.status, 'completed');
    assert.equal(ended.body.call.outcome, 'connected');

    const events = await api.get(`/calls/${callId}`);
    const types = events.body.events.map((event) => event.type);
    for (const expected of ['dial', 'answer', 'mute', 'hold', 'unhold', 'hangup']) {
      assert.ok(types.includes(expected), `expected a ${expected} event`);
    }
  });

  it('captures recording consent and writes it back to the contact', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const lead = (await api.get('/leads?limit=20')).body.leads.find((entry) => entry.phone && !entry.doNotCall);
    const { body } = await api.post('/calls', { leadId: lead.id });

    const granted = await api.post(`/calls/${body.call.id}/consent`, { granted: true, method: 'verbal' });
    assert.equal(granted.body.call.recordingConsent, 'granted');
    assert.equal(granted.body.call.recordingEnabled, true);

    const updatedLead = await api.get(`/leads/${lead.id}`);
    assert.equal(updatedLead.body.lead.consentRecording, 'granted');
  });

  it('blocks calls to a do-not-call contact', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const created = await api.post('/leads', {
      firstName: 'Do', lastName: 'NotCall', phone: '+15559998888', doNotCall: true,
    });
    const attempt = await api.post('/calls', { leadId: created.body.lead.id });
    assert.equal(attempt.status, 409);
  });

  it('matches an inbound call to the right CRM record', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const lead = (await api.get('/leads?limit=20')).body.leads.find((entry) => entry.phone);
    const inbound = await api.post('/calls/inbound', { fromNumber: lead.phone });
    assert.equal(inbound.status, 201);
    assert.equal(inbound.body.lead?.id, lead.id, 'the caller should be matched by number');
    assert.equal(inbound.body.call.direction, 'inbound');
  });

  it('runs the post-call AI pipeline end to end', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const lead = (await api.get('/leads?limit=20')).body.leads.find((entry) => entry.phone && !entry.doNotCall);

    const started = await api.post('/calls', { leadId: lead.id, recordingRequested: true });
    const callId = started.body.call.id;
    await api.post(`/calls/${callId}/consent`, { granted: true });
    await api.post(`/calls/${callId}/answer`);
    const ended = await api.post(`/calls/${callId}/end`, { outcome: 'connected' });
    assert.equal(ended.body.pipelineQueued, true, 'a recorded call should queue the AI pipeline');

    // The queue is disabled in tests; drain it deterministically instead.
    await drain({ timeoutMs: 30000 });

    const conversation = await api.get(`/conversations/${callId}`);
    assert.equal(conversation.status, 200);
    assert.ok(conversation.body.transcript, 'a transcript should exist');
    assert.ok(conversation.body.transcript.segments.length > 4, 'the transcript should have speaker turns');
    assert.ok(
      conversation.body.transcript.segments.some((segment) => segment.role === 'agent')
      && conversation.body.transcript.segments.some((segment) => segment.role === 'customer'),
      'speakers should be identified',
    );

    const analysis = conversation.body.analysis;
    assert.ok(analysis, 'an analysis should exist');
    assert.ok(analysis.summary.length > 40, 'the summary should be substantive');
    assert.ok(['positive', 'neutral', 'negative', 'mixed'].includes(analysis.sentiment));
    assert.ok(analysis.talkRatio > 0 && analysis.talkRatio < 1);
    assert.ok(typeof analysis.scorecard.overall === 'number', 'a coaching score should be produced');
    assert.ok(analysis.nextSteps.length > 0 || analysis.actionItems.length > 0, 'next steps should be extracted');
  });

  it('searches within a transcript', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const conversations = await api.get('/conversations?limit=1');
    const callId = conversations.body.conversations[0].callId;
    const result = await api.get(`/conversations/${callId}/transcript/search?q=recording`);
    assert.equal(result.status, 200);
    assert.ok(result.body.matches.length > 0, 'the consent line mentions recording');
    assert.ok(result.body.matches[0].highlights.length > 0);
  });
});

describe('calls placed on the agent handset', () => {
  const callableLead = async (api) => {
    const lead = (await api.get('/leads?limit=20')).body.leads.find((entry) => entry.phone && !entry.doNotCall);
    assert.ok(lead, 'need a callable lead');
    return lead;
  };

  it('creates the CRM record and returns a number for the handset to dial', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const lead = await callableLead(api);

    const { status, body } = await api.post('/calls', { leadId: lead.id, viaDevice: true });
    assert.equal(status, 201);
    assert.equal(body.call.leadId, lead.id, 'a handset call still associates to the lead');
    assert.equal(body.call.provider, 'device');
    assert.ok(body.dialNumber, 'the client needs a dialable number');
    assert.match(body.dialNumber, /^\+\d{6,}$/, 'the dial number should be E.164');
  });

  it('is never recorded, whatever the caller asks for', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const lead = await callableLead(api);

    const { body } = await api.post('/calls', { leadId: lead.id, viaDevice: true, recordingRequested: true });
    assert.equal(body.call.recordingEnabled, false, 'the handset gives the app no audio to record');

    const ended = await api.post(`/calls/${body.call.id}/end`, { outcome: 'connected' });
    assert.equal(ended.body.pipelineQueued, false, 'nothing to transcribe');
    assert.equal(ended.body.skipReason, 'not_recorded');
  });

  it('does not return a dial number for a provider call', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const lead = await callableLead(api);
    const { body } = await api.post('/calls', { leadId: lead.id });
    assert.equal(body.dialNumber, null);
    assert.notEqual(body.call.provider, 'device');
  });

  it('records a conversation the agent reports, rather than filing it as no answer', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const lead = await callableLead(api);

    // Nothing calls /answer: a carrier never reports back, which is exactly the
    // case that used to be stored as a no-answer.
    const { body } = await api.post('/calls', { leadId: lead.id, viaDevice: true });
    const ended = await api.post(`/calls/${body.call.id}/end`, { outcome: 'connected', notes: 'Asked for pricing' });

    assert.equal(ended.body.call.outcome, 'connected');
    assert.equal(ended.body.call.status, 'completed');
    assert.ok(ended.body.call.answeredAt, 'a reported conversation should have an answered time');
    assert.equal(ended.body.call.notes, 'Asked for pricing');
  });

  it('still files an unanswered handset call as no answer', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const lead = await callableLead(api);
    const { body } = await api.post('/calls', { leadId: lead.id, viaDevice: true });
    const ended = await api.post(`/calls/${body.call.id}/end`, { outcome: 'no_answer' });

    assert.equal(ended.body.call.outcome, 'no_answer');
    assert.equal(ended.body.call.status, 'no_answer');
    assert.equal(ended.body.call.answeredAt, null, 'no conversation, so no answered time');
  });

  it('still refuses a do-not-call contact', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const blocked = (await api.get('/leads?limit=100')).body.leads.find((entry) => entry.doNotCall);
    if (!blocked) return; // seeded data always has one, but do not fail if not
    const { status } = await api.post('/calls', { leadId: blocked.id, viaDevice: true });
    assert.equal(status, 409, 'the handset route must not bypass the do-not-call list');
  });

  it('marks the lead contacted, so follow-up logic sees the call', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const lead = await callableLead(api);
    const { body } = await api.post('/calls', { leadId: lead.id, viaDevice: true });
    await api.post(`/calls/${body.call.id}/end`, { outcome: 'connected' });
    await drain();

    const after = (await api.get(`/leads/${lead.id}`)).body.lead;
    assert.ok(after.lastContactedAt, 'a handset call is still contact');
  });
});

describe('the do-not-call list', () => {
  const blockedLead = async (api) => {
    const lead = (await api.get('/leads?limit=200')).body.leads.find((entry) => entry.doNotCall);
    assert.ok(lead, 'the seeded dataset should contain a do-not-call contact');
    return lead;
  };

  it('refuses a call placed by lead', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const lead = await blockedLead(api);
    assert.equal((await api.post('/calls', { leadId: lead.id })).status, 409);
  });

  it('refuses a call placed on the handset', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const lead = await blockedLead(api);
    assert.equal((await api.post('/calls', { leadId: lead.id, viaDevice: true })).status, 409);
  });

  it('refuses a call dialled by raw number, not just by lead', async () => {
    // The check used to run before the number was resolved back to a contact,
    // so dialling the number instead of naming the lead bypassed it entirely.
    // Typing a number in is precisely how someone reaches a number they should
    // not be calling, and this is a legal control rather than a convenience.
    const { api } = await login(ACCOUNTS.admin);
    const lead = await blockedLead(api);
    assert.ok(lead.phone, 'the blocked contact needs a number to dial');
    const { status } = await api.post('/calls', { toNumber: lead.phone });
    assert.equal(status, 409, 'dialling a flagged number directly must still be refused');
  });

  it('still allows a number that belongs to nobody on the list', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const { status } = await api.post('/calls', { toNumber: '+15550009999' });
    assert.equal(status, 201, 'an unflagged number must remain callable');
  });
});
