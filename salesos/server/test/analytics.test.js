import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, login, ACCOUNTS } from './helpers.js';

before(start);
after(stop);

describe('agent dashboard', () => {
  it('returns every panel the dashboard renders', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const { status, body } = await api.get('/analytics/dashboard');
    assert.equal(status, 200);
    for (const key of ['today', 'leads', 'followUps', 'tasks', 'deals', 'quota', 'conversations', 'callList']) {
      assert.ok(body[key] !== undefined, `dashboard is missing ${key}`);
    }
    assert.equal(typeof body.today.callsMade, 'number');
    assert.equal(typeof body.deals.pipelineValue, 'number');
    assert.ok(Array.isArray(body.callList));
  });

  it('ranks a call list with a reason for every entry', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const { body } = await api.get('/ai/call-list');
    for (const entry of body.callList) {
      assert.ok(entry.reasons.length > 0, 'every call recommendation must explain itself');
      assert.equal(typeof entry.rank, 'number');
    }
  });
});

describe('manager analytics', () => {
  it('is not available to an agent', async () => {
    const { api } = await login(ACCOUNTS.agent);
    assert.equal((await api.get('/analytics/team')).status, 403);
  });

  it('returns team metrics for a manager', async () => {
    const { api } = await login(ACCOUNTS.manager);
    const { status, body } = await api.get('/analytics/team');
    assert.equal(status, 200);
    assert.ok(body.agents.length > 0);
    assert.ok(body.totals.calls >= 0);
    assert.ok(Array.isArray(body.pipelineByStage));
    assert.ok(body.winLoss.winRate >= 0 && body.winLoss.winRate <= 100);
    for (const agent of body.agents) {
      assert.equal(typeof agent.connectRate, 'number');
      assert.ok(agent.connectRate >= 0 && agent.connectRate <= 100);
    }
  });

  it('computes a funnel where each stage is no larger than the one before', async () => {
    const { api } = await login(ACCOUNTS.manager);
    const { body } = await api.get('/analytics/funnel?since=2000-01-01T00:00:00.000Z');
    const open = body.funnel.filter((stage) => stage.stage !== 'won');
    for (let index = 1; index < open.length; index += 1) {
      assert.ok(
        open[index].deals <= open[index - 1].deals,
        `${open[index].stage} (${open[index].deals}) should not exceed ${open[index - 1].stage} (${open[index - 1].deals})`,
      );
    }
  });
});

describe('reports', () => {
  it('lists the report catalogue', async () => {
    const { api } = await login(ACCOUNTS.manager);
    const { body } = await api.get('/analytics/reports');
    assert.ok(body.reports.length >= 8);
    assert.ok(body.formats.includes('csv'));
  });

  it('builds every JSON report without error', async () => {
    const { api } = await login(ACCOUNTS.manager);
    const catalogue = (await api.get('/analytics/reports')).body.reports.filter((entry) => !entry.endpoint);
    for (const entry of catalogue) {
      const result = await api.get(`/analytics/reports/${entry.key}`);
      assert.equal(result.status, 200, `${entry.key} failed: ${JSON.stringify(result.body)}`);
      assert.ok(Array.isArray(result.body.rows), `${entry.key} should return rows`);
    }
  });

  it('rejects an unknown report', async () => {
    const { api } = await login(ACCOUNTS.manager);
    assert.equal((await api.get('/analytics/reports/not_a_report')).status, 400);
  });

  it('exports CSV with a header row', async () => {
    const { token } = await login(ACCOUNTS.manager);
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/api/v1/analytics/reports/lead_sources?format=csv`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv/);
    const text = await response.text();
    assert.ok(text.split('\n')[0].includes('source'), 'the CSV should have a header row');
  });
});

describe('coaching', () => {
  it('summarises scores per agent and per dimension', async () => {
    const { api } = await login(ACCOUNTS.manager);
    const { status, body } = await api.get('/coaching/overview');
    assert.equal(status, 200);
    assert.ok(body.dimensions.length === 8);
    if (body.agents.length) {
      const agent = body.agents[0];
      assert.ok(agent.averageScore >= 0 && agent.averageScore <= 100);
      assert.ok(agent.bestCall && agent.worstCall);
    }
  });

  it('returns per-agent coaching detail with a trend', async () => {
    const manager = await login(ACCOUNTS.manager);
    const overview = await manager.api.get('/coaching/overview');
    const agentId = overview.body.agents[0]?.agentId;
    if (!agentId) return;
    const { status, body } = await manager.api.get(`/coaching/agents/${agentId}`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.trend));
    assert.ok(Array.isArray(body.recommendations));
  });
});

describe('insights', () => {
  it('returns the full insight bundle', async () => {
    const { api } = await login(ACCOUNTS.manager);
    const { status, body } = await api.get('/ai/insights');
    assert.equal(status, 200);
    for (const key of ['likelyToConvert', 'dealsAtRisk', 'needsFollowUp', 'neverContacted', 'objectionTrends', 'lossAnalysis']) {
      assert.ok(body[key] !== undefined, `missing ${key}`);
    }
    for (const deal of body.dealsAtRisk) {
      assert.ok(deal.riskScore >= 0 && deal.riskScore <= 100);
      assert.ok(deal.reasons.length > 0, 'a risk score must be explained');
      assert.ok(deal.recommendedAction, 'a risk needs a recommended action');
    }
    for (const lead of body.likelyToConvert) {
      assert.ok(lead.factors.length > 0, 'a conversion score must be explained');
    }
  });
});
