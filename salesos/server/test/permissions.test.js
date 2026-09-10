import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, login, ACCOUNTS } from './helpers.js';

after(stop);

// One sign-in per account for the whole file, reused by every assertion. The
// auth limiter has a deliberately tight budget -- credential stuffing is what
// it is there for -- and a login per test trips it, which then fails as
// "rate_limited" in whichever test happens to be twenty-first rather than in
// the one that is actually wrong.
const sessions = {};
before(async () => {
  await start();
  for (const [role, email] of Object.entries(ACCOUNTS)) sessions[role] = await login(email);
});

describe('role-based access control', () => {
  it('blocks an agent from administrative endpoints', async () => {
    const { api } = sessions.agent;
    for (const path of ['/admin/users', '/admin/audit', '/admin/api-keys']) {
      const result = await api.get(path);
      assert.equal(result.status, 403, `${path} should be forbidden for an agent`);
    }
  });

  it('allows an admin to read users and the audit log', async () => {
    const { api } = sessions.admin;
    const users = await api.get('/admin/users');
    assert.equal(users.status, 200);
    assert.ok(users.body.users.length > 0);

    const audit = await api.get('/admin/audit');
    assert.equal(audit.status, 200);
    assert.ok(Array.isArray(audit.body.audit));
  });

  it('scopes an agent to their own records', async () => {
    const { api, user } = sessions.agent;
    const leads = await api.get('/leads?limit=200');
    assert.equal(leads.status, 200);
    const foreign = leads.body.leads.filter((lead) => lead.ownerId && lead.ownerId !== user.id);
    assert.equal(foreign.length, 0, 'an agent must only see leads they own');
  });

  it('refuses an agent the audit history of another agent\'s lead', async () => {
    // /timeline looks the lead up and calls assertRecordAccess; /audit did
    // neither, so the same lead was closed to one endpoint and open to the
    // other -- and audit entries carry a `diff` of the field values that
    // changed, which is more than the timeline shows.
    const mine = sessions.agent;
    const theirs = sessions.otherAgent;
    const foreign = (await theirs.api.get('/leads?limit=5')).body.leads[0];
    assert.ok(foreign, 'expected the other agent to own a lead');
    assert.notEqual(foreign.ownerId, mine.user.id);

    const timeline = await mine.api.get(`/leads/${foreign.id}/timeline`);
    assert.equal(timeline.status, 403, 'the timeline gate is the one being matched');

    const audit = await mine.api.get(`/leads/${foreign.id}/audit`);
    assert.equal(audit.status, 403,
      `reading another agent's lead audit returned ${audit.status}`);
  });

  it('refuses an agent the deletion of another agent\'s draft email', async () => {
    // Every other handler in emails.js calls assertRecordAccess on user_id;
    // DELETE was the one that did not, and email:send is an agent-rank
    // permission -- so a colleague's unsent draft was anyone's to remove.
    const mine = sessions.agent;
    const theirs = sessions.otherAgent;
    const theirLead = (await theirs.api.get('/leads?limit=1')).body.leads[0];
    assert.ok(theirLead, 'expected the other agent to own a lead');

    const draft = await theirs.api.post('/emails', {
      leadId: theirLead.id,
      subject: 'Draft belonging to another agent',
      body: 'Not yours to delete.',
    });
    assert.equal(draft.status, 201, `could not create the draft: ${JSON.stringify(draft.body)}`);

    const attempt = await mine.api.del(`/emails/${draft.body.email.id}`);
    assert.equal(attempt.status, 403, `deleting another agent's draft returned ${attempt.status}`);

    // And it is still there.
    const still = await theirs.api.get(`/emails/${draft.body.email.id}`);
    assert.equal(still.status, 200, 'the draft was deleted anyway');
  });

  it('lets a manager see the whole team', async () => {
    const agent = sessions.agent;
    const manager = sessions.manager;
    const agentLeads = await agent.api.get('/leads?limit=200');
    const managerLeads = await manager.api.get('/leads?limit=200');
    assert.ok(
      managerLeads.body.total >= agentLeads.body.total,
      'a manager should see at least as many leads as one of their agents',
    );
  });

  it('refuses cross-agent record access by id', async () => {
    const owner = sessions.agent;
    const other = sessions.otherAgent;
    const ownedLead = (await owner.api.get('/leads?limit=1')).body.leads[0];
    assert.ok(ownedLead, 'seed data should contain a lead');
    const attempt = await other.api.get(`/leads/${ownedLead.id}`);
    assert.equal(attempt.status, 403, 'another agent must not read this record');
  });

  it('stops an agent from reassigning a lead', async () => {
    const { api } = sessions.agent;
    const lead = (await api.get('/leads?limit=1')).body.leads[0];
    const result = await api.patch(`/leads/${lead.id}`, { ownerId: 'user_someone_else' });
    assert.equal(result.status, 403);
  });

  it('requires a super admin to change data retention', async () => {
    const admin = sessions.admin;
    const denied = await admin.api.patch('/admin/settings', { settings: { dataRetention: { recordingDays: 30 } } });
    assert.equal(denied.status, 403);

    const owner = sessions.owner;
    const allowed = await owner.api.patch('/admin/settings', { settings: { dataRetention: { recordingDays: 400 } } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.settings.dataRetention.recordingDays, 400);
  });
});

describe('AI suggestion scoping', () => {
  it('does not show one agent the AI suggestions on another agent records', async () => {
    const owner = sessions.agent;
    const other = sessions.otherAgent;

    const ownQueue = await owner.api.get('/ai/suggestions?status=all&limit=200');
    const otherQueue = await other.api.get('/ai/suggestions?status=all&limit=200');
    const ownIds = new Set(ownQueue.body.suggestions.map((entry) => entry.id));
    const overlap = otherQueue.body.suggestions.filter((entry) => ownIds.has(entry.id));
    assert.equal(overlap.length, 0, 'suggestion queues must not overlap between agents');
  });

  it('refuses to apply a suggestion on another agent record', async () => {
    const owner = sessions.agent;
    const other = sessions.otherAgent;
    const target = (await owner.api.get('/ai/suggestions?status=pending')).body.suggestions[0];
    if (!target) return;
    const attempt = await other.api.post(`/ai/suggestions/${target.id}/decide`, { action: 'approve' });
    assert.equal(attempt.status, 403);
  });
});

describe('the admin panel across roles', () => {
  // The panel is reachable from manager up, because the user directory is a
  // manager tool, but several of its screens read admin-only data. These assert
  // the split the navigation is filtered on: if a permission here is relaxed or
  // tightened, the tab list in web/src/pages/Admin.jsx has to move with it.
  const MANAGER_READABLE = ['users', 'teams', 'custom-fields', 'assignment-rules', 'settings', 'integrations', 'webhooks'];
  const ADMIN_ONLY = ['api-keys', 'audit', 'system', 'billing'];

  it('lets a manager load every section the panel offers them', async () => {
    const { api } = sessions.manager;
    for (const endpoint of MANAGER_READABLE) {
      const { status } = await api.get(`/admin/${endpoint}`);
      assert.equal(status, 200, `a manager should be able to read /admin/${endpoint}`);
    }
  });

  it('refuses a manager the admin-only sections', async () => {
    const { api } = sessions.manager;
    for (const endpoint of ADMIN_ONLY) {
      const { status } = await api.get(`/admin/${endpoint}`);
      assert.equal(status, 403, `/admin/${endpoint} should be admin-only`);
    }
  });

  it('gives an admin every section', async () => {
    const { api } = sessions.admin;
    for (const endpoint of [...MANAGER_READABLE, ...ADMIN_ONLY]) {
      const { status } = await api.get(`/admin/${endpoint}`);
      assert.equal(status, 200, `an admin should be able to read /admin/${endpoint}`);
    }
  });

  it('keeps an agent out of the panel entirely', async () => {
    const { api } = sessions.agent;
    assert.equal((await api.get('/admin/users')).status, 403);
  });
});

describe('organisation settings that change behaviour', () => {
  // These values are read at decision time, so a stored nonsense value changes
  // what the product does while the admin screen reports it back as accepted.
  // The dangerous one is a negative confidence threshold: in auto mode every
  // suggestion clears it, so a typo turns the confidence floor off entirely and
  // the AI writes to the CRM unreviewed.

  const patchApproval = (api, crmApproval) => api.patch('/admin/settings', { settings: { crmApproval } });

  it('refuses an unrecognised approval mode', async () => {
    for (const mode of ['automatic', 'banana', '', 123, null]) {
      const { status } = await patchApproval(sessions.admin.api, { mode });
      assert.equal(status, 422, `mode ${JSON.stringify(mode)} should be refused, got ${status}`);
    }
  });

  it('refuses a confidence threshold outside 0..1', async () => {
    for (const value of [5, -1, 'high', null]) {
      const { status } = await patchApproval(sessions.admin.api, { autoApplyConfidenceThreshold: value });
      assert.equal(status, 422, `threshold ${JSON.stringify(value)} should be refused, got ${status}`);
    }
  });

  it('refuses a non-boolean for the approval switches', async () => {
    assert.equal((await patchApproval(sessions.admin.api, { autoCreateTasks: 'yes' })).status, 422);
  });

  it('refuses an unrecognised recording consent mode', async () => {
    const { status } = await sessions.admin.api.patch('/admin/settings', { settings: { recording: { consentMode: 'sometimes' } } });
    assert.equal(status, 422, `got ${status}`);
  });

  it('still accepts the documented values', async () => {
    const { status, body } = await patchApproval(sessions.admin.api, {
      mode: 'suggest', autoApplyConfidenceThreshold: 0.9, autoCreateTasks: true,
    });
    assert.equal(status, 200);
    assert.equal(body.settings.crmApproval.mode, 'suggest');
    assert.equal(body.settings.crmApproval.autoApplyConfidenceThreshold, 0.9);
  });

  it('keeps fully automatic CRM updates a super-admin decision', async () => {
    assert.equal((await patchApproval(sessions.admin.api, { mode: 'auto' })).status, 403);
    assert.equal((await patchApproval(sessions.admin.api, { alwaysReviewSensitive: false })).status, 403);
    assert.equal((await patchApproval(sessions.owner.api, { mode: 'auto' })).status, 200);
    // Put it back so later tests see the safe default.
    assert.equal((await patchApproval(sessions.owner.api, { mode: 'suggest' })).status, 200);
  });
});
