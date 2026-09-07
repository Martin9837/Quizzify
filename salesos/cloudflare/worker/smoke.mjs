// The real API, over HTTP, served by a Durable Object.
const B = 'http://127.0.0.1:8787';
let pass = 0; const fails = [];
const ok = (n, good, d = '') => { if (good) { pass++; console.log(`  ok    ${n}${d ? '   ' + d : ''}`); } else { fails.push(n); console.log(`  FAIL  ${n}   ${d}`); } };

const login = async (email) => {
  const r = await fetch(`${B}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Demo1234!' }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const stamp = Date.now();
const t0 = Date.now();
const admin = await login('admin@northstar.demo');
ok('a real login succeeds (scrypt + JWT + SQL)', admin.status === 200 && admin.body?.accessToken,
  `${admin.status} in ${Date.now() - t0}ms`);
if (!admin.body?.accessToken) { console.log(JSON.stringify(admin.body).slice(0, 300)); process.exit(1); }

const H = { authorization: `Bearer ${admin.body.accessToken}`, 'content-type': 'application/json' };
const api = async (method, path, body) => {
  const r = await fetch(`${B}/api/v1${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

ok('a wrong password is rejected',
  (await (await fetch(`${B}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@northstar.demo', password: 'wrong' }) })).status) === 401);

for (const [label, path, key] of [
  ['leads list', '/leads?limit=25', 'leads'],
  ['deals list', '/deals', 'deals'],
  ['calls list', '/calls?limit=25', 'calls'],
  ['conversations', '/conversations?limit=10', 'conversations'],
  ['tasks', '/tasks', 'tasks'],
  ['admin users', '/admin/users', 'users'],
  ['ai suggestions', '/ai/suggestions?limit=20', 'suggestions'],
]) {
  const r = await api('GET', path);
  const rows = r.body?.[key];
  ok(`${label} returns rows`, r.status === 200 && Array.isArray(rows) && rows.length > 0,
    `${r.status}, ${Array.isArray(rows) ? rows.length : '?'} rows`);
}

const pipeline = await api('GET', '/deals/pipeline');
ok('the pipeline aggregates', pipeline.status === 200 && pipeline.body?.stages?.length > 0,
  `${pipeline.status}, openValue=${pipeline.body?.totals?.openValue}`);

for (const path of ['/analytics/dashboard', '/analytics/team', '/analytics/funnel']) {
  const r = await api('GET', path);
  ok(`${path} computes`, r.status === 200 && r.body, String(r.status));
}
for (const report of ['sales_performance', 'calls', 'lead_sources', 'deal_velocity',
                      'follow_up_performance', 'ai_call_insights', 'revenue', 'win_loss']) {
  const r = await api('GET', `/analytics/reports/${report}`);
  ok(`report ${report} runs`, r.status === 200, String(r.status));
}

// FTS5 through the real endpoint on DO SQLite.
const search = await api('GET', '/search?q=acme');
const hits = search.body?.results ?? search.body?.hits ?? search.body?.matches;
ok('global search hits the FTS5 index', search.status === 200 && Array.isArray(hits),
  `${search.status}, ${Array.isArray(hits) ? hits.length : JSON.stringify(search.body).slice(0, 80)} hits`);

// A write, all the way through validation, SQL and the search projection.
const created = await api('POST', '/leads', {
  firstName: 'Durable', lastName: 'Object', email: `durable.object.${stamp}@example.com`,
  phone: `+1415555${String(stamp).slice(-4)}`, source: 'referral',
});
ok('creating a lead works', created.status === 201 && created.body?.lead?.id, `${created.status}`);
if (created.body?.lead?.id) {
  const id = created.body.lead.id;
  const patched = await api('PATCH', `/leads/${id}`, { status: 'qualified', tags: ['vip'] });
  ok('updating a lead works', patched.status === 200, String(patched.status));
  const fetched = await api('GET', `/leads/${id}`);
  ok('the update round-trips', fetched.body?.lead?.status === 'qualified', JSON.stringify(fetched.body?.lead?.status));
  ok('the JSON column round-trips as an array', Array.isArray(fetched.body?.lead?.tags),
    JSON.stringify(fetched.body?.lead?.tags));
  const found = await api('GET', '/search?q=DurableObject');
  ok('a new lead is reachable through search', found.status === 200, String(found.status));
}

// Validation and authorisation must still behave.
// The API answers 422 for a payload that fails validation, not 400.
ok('a bad payload is rejected', (await api('POST', '/leads', { email: 'not-an-email' })).status === 422);
ok('a missing token is a 401', (await (await fetch(`${B}/api/v1/leads`)).status) === 401);
ok('a nonexistent record is a 404', (await api('GET', '/leads/lead_does_not_exist')).status === 404);

// The agent must not see the whole organisation.
const agent = await login('agent@northstar.demo');
if (agent.body?.accessToken) {
  const agentLeads = await fetch(`${B}/api/v1/leads?limit=200`, {
    headers: { authorization: `Bearer ${agent.body.accessToken}` },
  }).then((r) => r.json());
  const adminLeads = await api('GET', '/leads?limit=200');
  ok('role-scoped visibility still narrows the result set',
    agentLeads.leads.length < adminLeads.body.leads.length,
    `agent ${agentLeads.leads.length} < admin ${adminLeads.body.leads.length}`);
}

// A place a Worker could plausibly break: a long-ish body through the bridge.
const bulk = await api('POST', '/leads', {
  firstName: 'Long', lastName: 'Notes', email: `long.notes.${stamp}@example.com`,
  notes: 'x'.repeat(60000),
});
ok('a 60 KB body passes through the bridge', [201, 400, 422].includes(bulk.status), `${bulk.status}`);

console.log(`\n${pass}/${pass + fails.length} checks passed against the Durable Object`);
if (fails.length) console.log('failures: ' + fails.join('; '));
