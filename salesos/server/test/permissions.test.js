import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, login, ACCOUNTS } from './helpers.js';

before(start);
after(stop);

describe('role-based access control', () => {
  it('blocks an agent from administrative endpoints', async () => {
    const { api } = await login(ACCOUNTS.agent);
    for (const path of ['/admin/users', '/admin/audit', '/admin/api-keys']) {
      const result = await api.get(path);
      assert.equal(result.status, 403, `${path} should be forbidden for an agent`);
    }
  });

  it('allows an admin to read users and the audit log', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const users = await api.get('/admin/users');
    assert.equal(users.status, 200);
    assert.ok(users.body.users.length > 0);

    const audit = await api.get('/admin/audit');
    assert.equal(audit.status, 200);
    assert.ok(Array.isArray(audit.body.audit));
  });

  it('scopes an agent to their own records', async () => {
    const { api, user } = await login(ACCOUNTS.agent);
    const leads = await api.get('/leads?limit=200');
    assert.equal(leads.status, 200);
    const foreign = leads.body.leads.filter((lead) => lead.ownerId && lead.ownerId !== user.id);
    assert.equal(foreign.length, 0, 'an agent must only see leads they own');
  });

  it('lets a manager see the whole team', async () => {
    const agent = await login(ACCOUNTS.agent);
    const manager = await login(ACCOUNTS.manager);
    const agentLeads = await agent.api.get('/leads?limit=200');
    const managerLeads = await manager.api.get('/leads?limit=200');
    assert.ok(
      managerLeads.body.total >= agentLeads.body.total,
      'a manager should see at least as many leads as one of their agents',
    );
  });

  it('refuses cross-agent record access by id', async () => {
    const owner = await login(ACCOUNTS.agent);
    const other = await login(ACCOUNTS.otherAgent);
    const ownedLead = (await owner.api.get('/leads?limit=1')).body.leads[0];
    assert.ok(ownedLead, 'seed data should contain a lead');
    const attempt = await other.api.get(`/leads/${ownedLead.id}`);
    assert.equal(attempt.status, 403, 'another agent must not read this record');
  });

  it('stops an agent from reassigning a lead', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const lead = (await api.get('/leads?limit=1')).body.leads[0];
    const result = await api.patch(`/leads/${lead.id}`, { ownerId: 'user_someone_else' });
    assert.equal(result.status, 403);
  });

  it('requires a super admin to change data retention', async () => {
    const admin = await login(ACCOUNTS.admin);
    const denied = await admin.api.patch('/admin/settings', { settings: { dataRetention: { recordingDays: 30 } } });
    assert.equal(denied.status, 403);

    const owner = await login(ACCOUNTS.owner);
    const allowed = await owner.api.patch('/admin/settings', { settings: { dataRetention: { recordingDays: 400 } } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.settings.dataRetention.recordingDays, 400);
  });
});

describe('AI suggestion scoping', () => {
  it('does not show one agent the AI suggestions on another agent records', async () => {
    const owner = await login(ACCOUNTS.agent);
    const other = await login(ACCOUNTS.otherAgent);

    const ownQueue = await owner.api.get('/ai/suggestions?status=all&limit=200');
    const otherQueue = await other.api.get('/ai/suggestions?status=all&limit=200');
    const ownIds = new Set(ownQueue.body.suggestions.map((entry) => entry.id));
    const overlap = otherQueue.body.suggestions.filter((entry) => ownIds.has(entry.id));
    assert.equal(overlap.length, 0, 'suggestion queues must not overlap between agents');
  });

  it('refuses to apply a suggestion on another agent record', async () => {
    const owner = await login(ACCOUNTS.agent);
    const other = await login(ACCOUNTS.otherAgent);
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
    const { api } = await login(ACCOUNTS.manager);
    for (const endpoint of MANAGER_READABLE) {
      const { status } = await api.get(`/admin/${endpoint}`);
      assert.equal(status, 200, `a manager should be able to read /admin/${endpoint}`);
    }
  });

  it('refuses a manager the admin-only sections', async () => {
    const { api } = await login(ACCOUNTS.manager);
    for (const endpoint of ADMIN_ONLY) {
      const { status } = await api.get(`/admin/${endpoint}`);
      assert.equal(status, 403, `/admin/${endpoint} should be admin-only`);
    }
  });

  it('gives an admin every section', async () => {
    const { api } = await login(ACCOUNTS.admin);
    for (const endpoint of [...MANAGER_READABLE, ...ADMIN_ONLY]) {
      const { status } = await api.get(`/admin/${endpoint}`);
      assert.equal(status, 200, `an admin should be able to read /admin/${endpoint}`);
    }
  });

  it('keeps an agent out of the panel entirely', async () => {
    const { api } = await login(ACCOUNTS.agent);
    assert.equal((await api.get('/admin/users')).status, 403);
  });
});
