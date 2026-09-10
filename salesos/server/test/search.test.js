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

/**
 * A lead chosen the same way every run.
 *
 * These tests used `?limit=1`, which sorts by updated_at -- and the seed
 * writes all 64 leads in one pass, so several share a millisecond and the row
 * that came back was a coin toss. That is a proven flake: the same pattern
 * failed a sibling test about one run in ten, because some seeded leads are
 * marked do_not_call. The name also has to be one the search sanitiser keeps,
 * or a hit is not expected in the first place.
 */
async function stableLead(api) {
  const leads = (await api.get('/leads?limit=200&sort=first_name')).body.leads;
  const usable = leads
    .filter((lead) => (lead.lastName || lead.firstName || '').replace(/[^a-zA-Z0-9]/g, '').length > 1)
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.ok(usable.length, 'the seed should contain a lead with a searchable name');
  return usable[0];
}

describe('search endpoints', () => {
  it('finds a lead by name', async () => {
    const { api } = await login(ACCOUNTS.manager);
    const lead = await stableLead(api);
    const term = lead.lastName || lead.firstName;
    const result = await api.get(`/search?q=${encodeURIComponent(term)}`);
    assert.equal(result.status, 200);
    assert.ok(result.body.results.length > 0, `searching "${term}" found nothing`);
    assert.ok(result.body.results.some((entry) => entry.entityId === lead.id),
      `searching "${term}" did not return the lead it came from`);
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
    const ownLead = await stableLead(own.api);
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
