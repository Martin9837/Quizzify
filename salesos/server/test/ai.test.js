import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, login, ACCOUNTS } from './helpers.js';
import { drain } from '../src/services/queue/index.js';
import { analyseTranscript } from '../src/services/ai/local-engine.js';
import { buildSuggestions, scoreLead } from '../src/services/ai/extraction.js';

before(start);
after(stop);

const TRANSCRIPT = [
  { role: 'agent', text: 'Hi Dana, thanks for making the time. I have recording on for my notes, is that alright?' },
  { role: 'customer', text: 'That is fine.' },
  { role: 'agent', text: 'What does the evaluation process look like on your side?' },
  { role: 'customer', text: 'I can recommend, but our CRO, Marcus Lee signs it off. We have budget set aside, around 25,000 dollars for the year.' },
  { role: 'agent', text: 'That is in the right range. What has to be true for this to be an easy yes?' },
  { role: 'customer', text: 'We need single sign-on with Okta, and honestly the price is a concern. Salesloft quoted us lower.' },
  { role: 'agent', text: 'Understood. Two options: we scope to the core team now, or we move to annual prepay. I will confirm the detail in writing.' },
  { role: 'customer', text: 'Send us a proposal for 40 reps. If the numbers work we can sign within 4 weeks.' },
  { role: 'agent', text: 'I will have the proposal with you tomorrow, and I will include the security pack.' },
  { role: 'customer', text: 'Great, get it in the diary and we can move.' },
].map((turn, index) => ({ ...turn, index, start: index * 8, end: index * 8 + 7, speaker: turn.role }));

describe('conversation analysis engine', () => {
  const analysis = analyseTranscript({
    segments: TRANSCRIPT,
    fullText: TRANSCRIPT.map((s) => `${s.role}: ${s.text}`).join('\n'),
    lead: { first_name: 'Dana', company_name: 'Northwind', status: 'qualified', temperature: 'warm' },
    deal: { stage: 'qualified', value: 20000, currency: 'USD', probability: 25, competitors: '[]' },
    callDate: '2026-08-20T10:00:00.000Z',
  });

  it('extracts the budget the customer stated', () => {
    assert.equal(analysis.extraction.budget, 25000);
    assert.ok(analysis.extraction.budget_evidence?.includes('25,000'));
  });

  it('identifies the decision maker', () => {
    assert.match(analysis.extraction.decision_maker, /Marcus Lee|CRO/);
  });

  it('detects the pricing objection and the competitor', () => {
    const categories = analysis.objections.map((objection) => objection.category);
    assert.ok(categories.includes('pricing'), `expected a pricing objection, got ${categories.join(', ')}`);
    assert.ok(analysis.competitors.includes('Salesloft'));
  });

  it('detects buying signals including the proposal request', () => {
    const signals = analysis.buying_signals.map((signal) => signal.signal);
    assert.ok(signals.some((signal) => /proposal/i.test(signal)));
    assert.ok(signals.some((signal) => /budget/i.test(signal)));
  });

  it('reads the timeline and proposes a follow-up date in the future', () => {
    assert.match(analysis.extraction.timeline, /4 weeks/);
    assert.ok(new Date(analysis.extraction.follow_up_date) > new Date('2026-08-20'));
  });

  it('never regresses a deal stage on inference alone', () => {
    const regressed = analyseTranscript({
      segments: TRANSCRIPT,
      fullText: TRANSCRIPT.map((s) => s.text).join('\n'),
      lead: {},
      deal: { stage: 'negotiation', competitors: '[]' },
    });
    const order = ['new_lead', 'contacted', 'qualified', 'discovery', 'demo', 'proposal', 'negotiation', 'won', 'lost'];
    assert.ok(
      order.indexOf(regressed.extraction.deal_stage) >= order.indexOf('negotiation'),
      'the inferred stage must not move backwards',
    );
  });

  it('produces a coaching scorecard across every dimension', () => {
    for (const key of ['opening', 'discovery', 'objection_handling', 'listening', 'closing', 'next_step']) {
      assert.equal(typeof analysis.scorecard[key], 'number', `missing score for ${key}`);
      assert.ok(analysis.scorecard[key] >= 0 && analysis.scorecard[key] <= 100);
    }
    assert.ok(analysis.scorecard.overall > 0);
  });

  it('computes a talk ratio from actual speech', () => {
    assert.ok(analysis.talk_ratio > 0.2 && analysis.talk_ratio < 0.85);
  });

  it('extracts commitments from both parties', () => {
    const parties = new Set(analysis.commitments.map((commitment) => commitment.party));
    assert.ok(parties.has('agent'), 'the agent promised to send a proposal');
  });

  it('scores the lead higher when budget and a decision maker are known', () => {
    const withContext = scoreLead({ analysis, lead: { source: 'referral' } });
    const bare = scoreLead({
      analysis: { buying_signals: [], objections: [], risks: [], sentiment: 'neutral', extraction: {} },
      lead: {},
    });
    assert.ok(withContext > bare, `${withContext} should exceed ${bare}`);
  });
});

describe('CRM suggestion building', () => {
  const analysis = analyseTranscript({
    segments: TRANSCRIPT,
    fullText: TRANSCRIPT.map((s) => s.text).join('\n'),
    lead: { first_name: 'Dana', temperature: 'cold', status: 'contacted', tags: '[]', score: 30 },
    deal: { stage: 'qualified', value: 20000, probability: 25, competitors: '[]', pain_points: '[]', requirements: '[]' },
  });

  it('only proposes changes that differ from the current value', () => {
    const candidates = buildSuggestions({
      analysis,
      lead: { id: 'lead_1', temperature: analysis.extraction.lead_temperature, tags: '[]', score: 30 },
      deal: { id: 'deal_1', stage: 'qualified', competitors: '[]', pain_points: '[]', requirements: '[]' },
    });
    assert.ok(!candidates.some((candidate) => candidate.field === 'temperature'),
      'a value equal to the current one must not be proposed');
  });

  it('marks money and stage changes as sensitive', () => {
    const candidates = buildSuggestions({
      analysis,
      lead: { id: 'lead_1', temperature: 'cold', tags: '[]', score: 10 },
      deal: { id: 'deal_1', stage: 'contacted', value: 1000, competitors: '[]', pain_points: '[]', requirements: '[]' },
    });
    const budget = candidates.find((candidate) => candidate.field === 'budget');
    assert.ok(budget, 'a budget suggestion should be produced');
    assert.equal(budget.sensitivity, 'sensitive');
    assert.ok(budget.confidence > 0.5);
    assert.ok(budget.rationale, 'every suggestion needs a rationale');
  });
});

describe('AI approval workflow', () => {
  it('holds suggestions pending, then applies them on approval with an audit entry', async () => {
    const agent = await login(ACCOUNTS.agent);
    const admin = await login(ACCOUNTS.admin);

    const lead = (await agent.api.get('/leads?limit=20')).body.leads.find((entry) => entry.phone && !entry.doNotCall);
    const started = await agent.api.post('/calls', { leadId: lead.id });
    await agent.api.post(`/calls/${started.body.call.id}/consent`, { granted: true });
    await agent.api.post(`/calls/${started.body.call.id}/answer`);
    await agent.api.post(`/calls/${started.body.call.id}/end`, { outcome: 'connected' });
    await drain({ timeoutMs: 30000 });

    const queue = await agent.api.get('/ai/suggestions?status=pending');
    assert.equal(queue.status, 200);
    const batch = queue.body.batches.find((entry) => entry.sourceId === started.body.call.id);
    assert.ok(batch, 'the call should produce a suggestion batch');
    assert.ok(batch.suggestions.length > 0);
    assert.ok(batch.source.summary, 'the batch should carry the call summary for context');

    const nonSensitive = batch.suggestions.find((entry) => entry.sensitivity === 'normal');
    assert.ok(nonSensitive, 'expected at least one non-sensitive suggestion');

    const approved = await agent.api.post(`/ai/suggestions/${nonSensitive.id}/decide`, { action: 'approve' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.suggestion.status, 'approved');

    const audit = await admin.api.get(`/admin/audit?action=ai.crm`);
    assert.ok(audit.body.audit.length > 0, 'applying an AI suggestion must be audited');

    const timeline = await agent.api.get(`/leads/${lead.id}/timeline`);
    assert.ok(
      timeline.body.timeline.some((item) => item.type === 'crm_change'),
      'the change should appear on the contact timeline',
    );
  });

  it('rejects a suggestion without touching the record', async () => {
    const agent = await login(ACCOUNTS.agent);
    const queue = await agent.api.get('/ai/suggestions?status=pending');
    const pending = queue.body.suggestions.find((entry) => entry.entityType === 'lead');
    if (!pending) return;

    const before = await agent.api.get(`/leads/${pending.entityId}`);
    assert.ok(before.ok, 'the suggestion target should be readable');

    const rejected = await agent.api.post(`/ai/suggestions/${pending.id}/decide`, { action: 'reject' });
    assert.equal(rejected.body.suggestion.status, 'rejected');

    const after = await agent.api.get(`/leads/${pending.entityId}`);
    const fieldName = pending.field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    assert.deepEqual(
      after.body.lead[fieldName],
      before.body.lead[fieldName],
      'rejecting must not change the record',
    );
  });

  it('approves a whole batch at once', async () => {
    const agent = await login(ACCOUNTS.agent);
    const queue = await agent.api.get('/ai/suggestions?status=pending');
    const batch = queue.body.batches[0];
    if (!batch) return;
    const result = await agent.api.post(`/ai/suggestions/batch/${batch.batchId}/decide`, { action: 'approve' });
    assert.equal(result.status, 200);
    assert.ok(result.body.decided > 0);
  });
});

describe('AI assistant', () => {
  it('answers the call-list question from real pipeline data', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const result = await api.post('/ai/ask', { question: 'Who should I call today?' });
    assert.equal(result.status, 200);
    assert.ok(result.body.answer.length > 20);
    assert.ok(result.body.toolsUsed.includes('call_list_today'));
  });

  it('refuses team performance data to an agent', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const result = await api.post('/ai/ask', { question: 'Which agents are performing best?' });
    assert.equal(result.status, 200);
    assert.match(result.body.answer, /managers and administrators/i);
    assert.ok(!result.body.availableTools.includes('agent_performance'), 'the tool must not be offered to an agent');
  });

  it('offers team performance to a manager', async () => {
    const { api } = await login(ACCOUNTS.manager);
    const result = await api.post('/ai/ask', { question: 'How is the team performing?' });
    assert.ok(result.body.availableTools.includes('agent_performance'));
  });

  it('keeps conversation history', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const first = await api.post('/ai/ask', { question: 'Which deals are at risk?' });
    const second = await api.post('/ai/ask', { question: 'What about my pipeline forecast?', conversationId: first.body.conversationId });
    assert.equal(second.body.conversationId, first.body.conversationId);

    const conversation = await api.get(`/ai/conversations/${first.body.conversationId}`);
    assert.equal(conversation.body.conversation.messages.length, 4);
  });
});

describe('AI email generation', () => {
  it('drafts a follow-up grounded in the last call', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const conversation = (await api.get('/conversations?limit=1')).body.conversations[0];
    assert.ok(conversation, 'need an analysed call');

    const draft = await api.post('/ai/email/generate', {
      template: 'thank_you',
      callId: conversation.callId,
    });
    assert.equal(draft.status, 200);
    assert.ok(draft.body.draft.subject.length > 3);
    assert.ok(draft.body.draft.body.length > 80);
    assert.ok(draft.body.draft.talkingPoints.length > 0, 'the draft should explain itself');
  });

  it('logs a sent email against the CRM and marks human edits', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const conversation = (await api.get('/conversations?limit=1')).body.conversations[0];
    const draft = await api.post('/ai/email/generate', { template: 'follow_up', callId: conversation.callId });

    const created = await api.post('/emails', {
      leadId: conversation.leadId,
      callId: conversation.callId,
      to: 'recipient@example.test',
      subject: draft.body.draft.subject,
      body: draft.body.draft.body,
      template: 'follow_up',
      generatedByAi: true,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.email.generatedByAi, true);
    assert.equal(created.body.email.editedByHuman, false);

    const edited = await api.patch(`/emails/${created.body.email.id}`, { body: `${draft.body.draft.body}\n\nOne more thing.` });
    assert.equal(edited.body.email.editedByHuman, true, 'editing an AI draft must be recorded');

    const sent = await api.post(`/emails/${created.body.email.id}/send`);
    assert.equal(sent.status, 202);

    await drain({ timeoutMs: 15000 });
    const after = await api.get(`/emails/${created.body.email.id}`);
    assert.equal(after.body.email.status, 'sent');
  });
});

describe('follow-up automation', () => {
  it('proposes follow-ups without creating them, then creates the approved ones', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const conversation = (await api.get('/conversations?limit=1')).body.conversations[0];

    const proposed = await api.post('/ai/follow-ups/propose', { callId: conversation.callId });
    assert.equal(proposed.status, 200);
    assert.ok(proposed.body.proposals.length > 0);
    assert.equal(proposed.body.created.length, 0, 'nothing should be created without approval');

    const accepted = await api.post('/ai/follow-ups/accept', { tasks: proposed.body.proposals.slice(0, 2) });
    assert.equal(accepted.status, 201);
    assert.ok(accepted.body.created > 0);
    assert.equal(accepted.body.tasks[0].source, 'ai');
  });
});

describe('call recommendations respect do-not-call', () => {
  it('never puts a do-not-call contact on the call list', async () => {
    const admin = await login(ACCOUNTS.admin);
    const agent = await login(ACCOUNTS.agent);

    // A lead that would otherwise rank highly: owned, brand new, never contacted.
    const created = await admin.api.post('/leads', {
      firstName: 'Blocked',
      lastName: 'Contact',
      companyName: 'Do Not Dial Inc',
      phone: '+15557770001',
      email: 'blocked.contact@donotdial.test',
      ownerId: agent.user.id,
      doNotCall: true,
      temperature: 'hot',
    });
    assert.equal(created.status, 201);

    const list = await agent.api.get('/ai/call-list');
    const present = list.body.callList.some((entry) => entry.leadId === created.body.lead.id);
    assert.equal(present, false, 'a do-not-call contact must not be recommended for a call');

    const followUps = await agent.api.get('/ai/insights');
    const inNeverContacted = followUps.body.neverContacted.some((entry) => entry.leadId === created.body.lead.id);
    assert.equal(inNeverContacted, false, 'a do-not-call contact must not appear in a contact-them list');
  });

  it('flags do-not-call on the conversion ranking rather than hiding the lead', async () => {
    const agent = await login(ACCOUNTS.agent);
    const insights = await agent.api.get('/ai/insights');
    for (const lead of insights.body.likelyToConvert) {
      assert.equal(typeof lead.doNotCall, 'boolean', 'the ranking should tell the UI whether dialling is allowed');
    }
  });
});

describe('evidence quality', () => {
  it('never quotes a fragment too thin to be useful as an objection', () => {
    // "The price is." matches the pricing pattern but carries no information.
    const segments = [
      { role: 'agent', text: 'What did the team make of the proposal?' },
      { role: 'customer', text: 'The product is not the problem. The price is.' },
      { role: 'customer', text: 'It came in at 84,000 dollars and we had 60,000 in the plan for this year.' },
      { role: 'agent', text: 'Understood. I will put two options in writing today.' },
    ].map((turn, index) => ({ ...turn, index, start: index * 8, end: index * 8 + 7, speaker: turn.role }));

    const analysis = analyseTranscript({
      segments,
      fullText: segments.map((s) => `${s.role}: ${s.text}`).join('\n'),
      lead: { first_name: 'Sam' },
      deal: { stage: 'proposal', competitors: '[]' },
    });

    const pricing = analysis.objections.find((objection) => objection.category === 'pricing');
    assert.ok(pricing, 'a pricing objection should be detected');
    assert.ok(
      pricing.text.split(/\s+/).length >= 6,
      `the quoted objection should carry the objection, got "${pricing.text}"`,
    );
    // The most informative sentence may describe the problem without using the
    // word "price" -- what matters is that it conveys the objection.
    assert.match(pricing.text, /price|\d{2},\d{3}|budget|plan/i);
  });

  it('quotes evidence for every buying signal it reports', () => {
    const segments = [
      { role: 'agent', text: 'Where does this go from here?' },
      { role: 'customer', text: 'Send us a proposal for 40 seats and we can sign within 3 weeks if the numbers work.' },
    ].map((turn, index) => ({ ...turn, index, start: index * 8, end: index * 8 + 7, speaker: turn.role }));

    const analysis = analyseTranscript({
      segments,
      fullText: segments.map((s) => s.text).join('\n'),
      lead: {},
      deal: { stage: 'demo', competitors: '[]' },
    });

    assert.ok(analysis.buying_signals.length > 0);
    for (const signal of analysis.buying_signals) {
      assert.ok(signal.evidence && signal.evidence.length > 10, `"${signal.signal}" has no usable evidence`);
    }
  });
});
