import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, login, ACCOUNTS } from './helpers.js';

// Each of these reproduces a defect found by pointing test agents at a running
// instance in the state a fresh deployment is actually in: no records, one
// account, no teams. They are grouped by what went wrong rather than by
// endpoint, because several of them share a cause.

after(stop);

const sessions = {};
before(async () => {
  await start();
  for (const [role, email] of Object.entries(ACCOUNTS)) sessions[role] = await login(email);
});

describe('a scope that resolves to nobody', () => {
  it('returns nothing rather than the whole organisation', async () => {
    // The SQL blocks in this handler read an empty owner list as "matches
    // nothing"; three insight widgets turned it into 'all'. So a team with no
    // active members came back with zeroed totals beside another team's
    // at-risk deals, loss reasons and objections.
    const { body, status } = await sessions.admin.api.get('/analytics/team?teamId=team_does_not_exist');
    assert.equal(status, 200);
    assert.equal(body.agents.length, 0, 'a team that does not exist has no members');
    assert.deepEqual(body.dealsAtRisk, [], 'deals leaked past an empty scope');
    assert.deepEqual(body.objections.objections, [], 'objections leaked past an empty scope');
    assert.equal(body.objections.totalCallsAnalysed, 0, 'analysed calls leaked past an empty scope');
    assert.equal(body.winLoss.wonCount, 0, 'win/loss leaked past an empty scope');
    assert.equal(body.winLoss.lostCount, 0, 'win/loss leaked past an empty scope');
  });

  it('refuses a manager another team', async () => {
    // The teamId was taken from the query string unchecked, so a manager could
    // read any team's per-agent revenue, quota and call scores by naming it.
    const teams = (await sessions.admin.api.get('/admin/teams')).body.teams;
    const foreign = teams.find((team) => team.id !== sessions.manager.user.teamId);
    assert.ok(foreign, 'the seed should contain a team the manager does not run');

    const attempt = await sessions.manager.api.get(`/analytics/team?teamId=${foreign.id}`);
    assert.equal(attempt.status, 403, `a manager read another team, got ${attempt.status}`);

    const own = await sessions.manager.api.get(`/analytics/team?teamId=${sessions.manager.user.teamId}`);
    assert.equal(own.status, 200, 'a manager must still be able to read their own team');
  });
});

describe('query parameters that are not numbers', () => {
  // Number('1e400') is Infinity, which neither Date nor SQLite can take: the
  // first threw "Invalid time value" from toISOString, the second failed as
  // SQLITE_MISMATCH binding LIMIT. Every one of these was a 500 from an
  // ordinary query string.
  const HOSTILE = ['1e400', '1e309', 'Infinity', '-1e400', '9007199254740993', 'abc', ''];

  const paths = [
    '/notifications?limit=',
    '/ai/suggestions?limit=',
    '/coaching/calls?limit=',
    '/search?q=acme&limit=',
    '/analytics/reports/revenue?days=',
    '/ai/meeting-slots?duration=',
    '/ai/meeting-slots?days=',
    '/meetings/slots/suggest?duration=',
  ];

  for (const path of paths) {
    it(`survives ${path}<nonsense>`, async () => {
      for (const value of HOSTILE) {
        const { status } = await sessions.admin.api.get(`${path}${value}`);
        assert.ok(status < 500, `${path}${value} returned ${status}`);
      }
    });
  }

  it('survives a sentence asking for the last several trillion days', async () => {
    // Reachable by typing into the search box, not just by crafting a URL.
    const { status, body } = await sessions.admin.api.post('/search/natural', {
      query: 'deals from last 999999999999 days',
    });
    assert.equal(status, 200, `the natural-language search returned ${status}`);
    assert.ok(!String(body.interpretation?.since).startsWith('-'),
      `an out-of-range day count produced a negative year: ${body.interpretation?.since}`);
  });
});

describe('inherited object keys are not report names', () => {
  it('refuses them the way any other unknown report is refused', async () => {
    // REPORTS[name] was truthy for everything on Object.prototype. Five keys
    // were 500s; `toString` answered 200 with rows as the string
    // "[object Undefined]" and count as its length, and `constructor` echoed
    // the internal organisation id back.
    for (const key of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
      const { status, body } = await sessions.admin.api.get(`/analytics/reports/${key}`);
      assert.equal(status, 400, `/analytics/reports/${key} returned ${status}`);
      assert.match(body.error.message, /Unknown report/);
    }
  });

  it('still serves the real ones', async () => {
    const { status, body } = await sessions.admin.api.get('/analytics/reports/revenue');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.rows), 'rows must be an array');
  });
});

describe('a search box that cannot match anything', () => {
  it('answers with nothing, not with everything', async () => {
    // The sanitiser strips FTS metacharacters and one-letter words; when
    // nothing survived, the MATCH clause was skipped and the query fell
    // through to "the most recent of everything", so `*` was answered with
    // every record in the organisation.
    for (const query of ['*', '%', '(', '"', 'a', '1', 'the and for']) {
      const { status, body } = await sessions.admin.api.get(`/search?q=${encodeURIComponent(query)}`);
      assert.equal(status, 200);
      assert.equal(body.total, 0, `"${query}" matched ${body.total} records`);
    }
  });

  it('still answers a real query', async () => {
    const { body } = await sessions.admin.api.get('/search?q=a&types=lead');
    assert.equal(body.total, 0);
    const real = await sessions.admin.api.get('/search?q=northwind');
    assert.ok(real.body.total >= 0);
  });

  it('keeps the filters when a sentence leaves only stopwords behind', async () => {
    // "my leads from this week" parses to an owner, an entity type and a date
    // range, and leaves "show all from" as residual text. Refusing to answer
    // because the residue matches nothing would throw the parsed filters away.
    const { status, body } = await sessions.agent.api.post('/search/natural', {
      query: 'show me all my leads from this week',
    });
    assert.equal(status, 200);
    assert.deepEqual(body.interpretation.entityTypes, ['lead']);
    assert.ok(body.interpretation.since, 'the date range should have been parsed');
    assert.equal(body.interpretation.scopedToMe, true);
  });

  it('answers an empty query with the shape it answers a real one with', async () => {
    const empty = await sessions.admin.api.get('/search?q=');
    assert.equal(empty.body.total, 0, 'total was missing from the empty response');

    const natural = await sessions.admin.api.post('/search/natural', { query: '' });
    assert.equal(natural.body.total, 0);
    assert.ok(natural.body.interpretation, 'interpretation was missing from the empty response');
    assert.equal(natural.body.filters, undefined, 'the empty path used a different key');
  });
});

describe('deals created at a stage they did not walk to', () => {
  it('records the close date, so revenue reports can see them', async () => {
    // closed_at was only ever set on transition. A deal imported straight in
    // as won had it NULL, and every revenue, win-rate and quota query filters
    // on it -- so /deals/pipeline showed the value while the dashboard showed
    // zero revenue for the same row.
    const created = await sessions.admin.api.post('/deals', {
      name: 'Imported as already won',
      stage: 'won',
      value: 250000,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.ok(created.body.deal.closedAt, 'a deal created as won has no close date');

    const won = await sessions.admin.api.get('/analytics/reports/revenue?days=1');
    const total = won.body.rows.reduce((sum, row) => sum + row.revenue, 0);
    assert.ok(total >= 250000, `the won deal is missing from the revenue report (${total})`);
  });

  it('refuses to record a loss with no reason, on every path that can', async () => {
    const created = await sessions.admin.api.post('/deals', { name: 'Lost with no reason', stage: 'lost', value: 1000 });
    assert.equal(created.status, 422, `creating a reason-less lost deal returned ${created.status}`);
    assert.equal(created.body.error.code, 'lost_reason_required');

    const open = await sessions.admin.api.post('/deals', { name: 'Open for now', stage: 'qualified', value: 1000 });
    assert.equal(open.status, 201);
    const patched = await sessions.admin.api.patch(`/deals/${open.body.deal.id}`, { stage: 'lost' });
    assert.equal(patched.status, 422, 'PATCH answered differently from POST');
    assert.equal(patched.body.error.code, 'lost_reason_required');

    const withReason = await sessions.admin.api.patch(`/deals/${open.body.deal.id}`, {
      stage: 'lost', lostReason: 'Chose a competitor',
    });
    assert.equal(withReason.status, 200);
  });
});

describe('the funnel', () => {
  it('measures conversion against the first stage that has deals', async () => {
    // conversionFromTop divided by stages[0], which is new_lead. Deals created
    // at the stage they are really at leave new_lead empty, and the entire
    // column came back null -- including for stages holding real deals.
    const created = await sessions.admin.api.post('/deals', { name: 'Straight to qualified', stage: 'qualified', value: 5000 });
    assert.equal(created.status, 201);

    const { body } = await sessions.admin.api.get('/analytics/funnel');
    const baseline = body.funnel.find((stage) => stage.stage === body.baselineStage);
    assert.ok(baseline, 'the response should name the stage it measured from');
    assert.equal(baseline.conversionFromTop, 100, 'the baseline stage is 100% of itself');
    for (const stage of body.funnel) {
      assert.notEqual(stage.conversionFromTop, null,
        `${stage.stage} has no conversion from top even though ${body.baselineStage} has deals`);
    }
  });
});

describe('a call that did more than connect', () => {
  it('counts as connected', async () => {
    // `connected` is the outcome for "spoke to them and nothing more specific
    // happened". Counting only that made an agent whose every call booked a
    // meeting show a 0% connect rate.
    //
    // The lead is created here rather than taken from the seed. Reading one
    // with ?limit=1 sorts by updated_at, which the seed writes in a single
    // pass -- so the row that came back varied between runs, and some seeded
    // leads are marked do_not_call and cannot be phoned at all. That made this
    // test fail roughly one run in ten, on the call rather than on the count.
    const { api, user } = sessions.admin;
    const lead = await api.post('/leads', {
      firstName: 'Connect',
      lastName: 'Rate',
      companyName: 'Answered The Phone Ltd',
      phone: '+15550000200',
      ownerId: user.id,
      consentRecording: 'granted',
    });
    assert.equal(lead.status, 201, JSON.stringify(lead.body));

    const before = (await api.get('/analytics/dashboard')).body.today.callsConnected;

    const placed = await api.post('/calls', { leadId: lead.body.lead.id });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    const ended = await api.post(`/calls/${placed.body.call.id}/end`, { outcome: 'meeting_booked' });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal(ended.body.call.outcome, 'meeting_booked', 'the requested outcome was not recorded');

    const after = (await api.get('/analytics/dashboard')).body.today.callsConnected;
    assert.equal(after, before + 1,
      'a call that booked a meeting was not counted as connected');
  });
});

describe('collection envelopes', () => {
  it('report a total wherever they accept limit and offset', async () => {
    // A client cannot page an endpoint that will not say how many rows there
    // are, nor render "showing N of M".
    for (const path of ['/leads', '/deals', '/calls', '/tasks', '/companies', '/activities', '/notifications']) {
      const { status, body } = await sessions.admin.api.get(path);
      assert.equal(status, 200, `${path} returned ${status}`);
      assert.equal(typeof body.total, 'number', `${path} returned no total`);
    }
  });

  it('answers a missing required parameter with 400, not 404', async () => {
    // /notes threw notFound, producing "leadId or dealId not found" -- as
    // though a record by that name had been looked for. /messages, the same
    // check on the same kind of endpoint, has always answered 400.
    for (const path of ['/notes', '/messages']) {
      const { status } = await sessions.admin.api.get(path);
      assert.equal(status, 400, `${path} returned ${status} for a missing parameter`);
    }
  });
});

describe('an export with no rows', () => {
  it('is a header, not an empty file', async () => {
    // toCsv returned '' before computing headers, so every zero-row export
    // downloaded as 0 bytes -- indistinguishable from a failed download, and
    // a corrupt sheet when opened.
    const { status, body } = await sessions.admin.api
      .get('/analytics/reports/calls?since=2030-01-01T00:00:00.000Z&until=2030-01-02T00:00:00.000Z&format=csv');
    assert.equal(status, 200);
    assert.equal(typeof body, 'string');
    assert.equal(body.split('\n')[0], 'day,agent,calls,connected,talk_minutes');
  });
});

describe('the last administrator', () => {
  it('cannot be demoted to any role that would lock the organisation out', async () => {
    // The guard enumerated the changes it feared -- role 'agent' and status
    // 'suspended' -- so 'manager' and 'invited' went straight through, and
    // user:write is itself an admin permission: nobody would be left who
    // could promote anyone back.
    const owner = sessions.owner;
    const users = (await owner.api.get('/admin/users')).body.users;
    const others = users.filter((user) => ['admin', 'super_admin'].includes(user.role) && user.id !== owner.user.id);

    // Leave the super admin as the only administrator.
    for (const user of others) {
      const { status } = await owner.api.patch(`/admin/users/${user.id}`, { status: 'suspended' });
      assert.equal(status, 200, `could not suspend ${user.email}: ${status}`);
    }

    for (const patch of [{ role: 'manager' }, { role: 'agent' }, { status: 'suspended' }, { status: 'invited' }]) {
      const { status, body } = await owner.api.patch(`/admin/users/${owner.user.id}`, patch);
      assert.equal(status, 400,
        `${JSON.stringify(patch)} on the last administrator returned ${status}`);
      assert.match(body.error.message, /last active administrator/);
    }

    // Still an administrator, and still able to administer.
    const after = await owner.api.get('/admin/users');
    assert.equal(after.status, 200);
    assert.equal(after.body.users.find((user) => user.id === owner.user.id).role, 'super_admin');
  });
});
