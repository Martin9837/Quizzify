import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, login, ACCOUNTS } from './helpers.js';
import { parseNaturalQuery } from '../src/services/search/index.js';

before(start);
after(stop);

describe('natural language query parsing', () => {
  it('extracts temperature, recency, ownership and topic', () => {
    const filters = parseNaturalQuery(
      'Show me all hot leads I spoke with last week who mentioned pricing concerns',
      { userId: 'user_me' },
    );
    assert.equal(filters.temperature, 'hot');
    assert.equal(filters.ownerId, 'user_me');
    assert.ok(filters.since, 'a date range should be derived from "last week"');
    assert.ok(filters.topics.includes('pricing'));
    assert.ok(filters.entityTypes.includes('lead'));
    assert.ok(filters.entityTypes.includes('call') || filters.entityTypes.includes('transcript'));
  });

  it('handles an explicit day count', () => {
    const filters = parseNaturalQuery('customers who have not been contacted in last 30 days');
    assert.ok(filters.since);
    const daysAgo = Math.round((Date.now() - new Date(filters.since)) / 86400000);
    assert.ok(daysAgo >= 29 && daysAgo <= 31, `expected roughly 30 days, got ${daysAgo}`);
  });

  it('recognises deal stages', () => {
    const filters = parseNaturalQuery('deals in negotiation over 50k');
    assert.equal(filters.stage, 'negotiation');
    assert.ok(filters.entityTypes.includes('deal'));
  });
});

describe('search endpoints', () => {
  it('finds a lead by name', async () => {
    const { api } = await login(ACCOUNTS.manager);
    const leads = (await api.get('/leads?limit=1')).body.leads;
    const term = leads[0].lastName || leads[0].firstName;
    const result = await api.get(`/search?q=${encodeURIComponent(term)}`);
    assert.equal(result.status, 200);
    assert.ok(result.body.results.length > 0);
    assert.ok(result.body.results.every((entry) => entry.href), 'every hit should be linkable');
  });

  it('searches inside transcripts', async () => {
    const { api } = await login(ACCOUNTS.manager);
    const result = await api.get('/search?q=budget&types=transcript');
    assert.equal(result.status, 200);
    assert.ok(result.body.results.length > 0, 'seeded transcripts discuss budget');
  });

  it('returns the interpretation for a natural language search', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const result = await api.post('/search/natural', {
      query: 'hot leads I spoke with last week who mentioned pricing',
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.interpretation.temperature, 'hot');
    assert.equal(result.body.interpretation.scopedToMe, true);
  });

  it('does not leak another agent records through search', async () => {
    const other = await login(ACCOUNTS.otherAgent);
    const own = await login(ACCOUNTS.agent);
    const ownLead = (await own.api.get('/leads?limit=1')).body.leads[0];
    const result = await other.api.get(`/search?q=${encodeURIComponent(ownLead.lastName || ownLead.firstName)}`);
    const leaked = result.body.results.filter((entry) => entry.entityId === ownLead.id);
    assert.equal(leaked.length, 0, 'search must respect record scope');
  });

  it('powers the command palette typeahead', async () => {
    const { api } = await login(ACCOUNTS.manager);
    const result = await api.get('/search/suggest?q=north');
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.body.suggestions));
  });
});
