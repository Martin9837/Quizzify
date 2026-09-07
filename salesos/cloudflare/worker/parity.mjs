// The same request sequence against both engines. A difference in status or in
// the shape of the answer is the only thing that matters here -- absolute
// values differ because each has its own seeded dataset.
const ENGINES = { node: 'http://127.0.0.1:4300', durableObject: 'http://127.0.0.1:8787' };

const run = async (base) => {
  const login = async (email, password = 'Demo1234!') => {
    const r = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const admin = await login('admin@northstar.demo');
  const H = { authorization: `Bearer ${admin.body?.accessToken}`, 'content-type': 'application/json' };
  const call = async (method, path, body) => {
    const r = await fetch(`${base}/api/v1${path}`, {
      method, headers: H, body: body ? JSON.stringify(body) : undefined,
    });
    const parsed = await r.json().catch(() => null);
    return { status: r.status, keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).sort().join(',') : typeof parsed };
  };

  const out = { 'POST /auth/login': { status: admin.status, keys: Object.keys(admin.body || {}).sort().join(',') } };
  const probes = [
    ['GET', '/notifications'],
    ['GET', '/analytics/overview'],
    ['GET', '/analytics'],
    ['GET', '/analytics/summary'],
    ['GET', '/insights/overview'],
    ['GET', '/leads?limit=5'],
    ['GET', '/companies'],
    ['GET', '/search?q=acme'],
    ['GET', '/admin/audit?limit=5'],
    ['GET', '/admin/settings'],
    ['GET', '/queue/stats'],
    ['GET', '/admin/jobs'],
  ];
  for (const [method, path] of probes) out[`${method} ${path}`] = await call(method, path);

  // Validation: the same malformed payloads.
  out['POST /leads {email:"not-an-email"}'] = await call('POST', '/leads', { email: 'not-an-email' });
  out['POST /leads {}'] = await call('POST', '/leads', {});
  out['POST /leads {firstName:1234}'] = await call('POST', '/leads', { firstName: 1234 });
  out['PATCH /leads/nope'] = await call('PATCH', '/leads/lead_nope', { status: 'qualified' });
  out['GET /leads/nope'] = await call('GET', '/leads/lead_nope');
  out['POST /login wrong password'] = await (async () => {
    const r = await login('admin@northstar.demo', 'wrong-password');
    return { status: r.status, keys: Object.keys(r.body || {}).sort().join(',') };
  })();
  return out;
};

const results = {};
for (const [name, base] of Object.entries(ENGINES)) results[name] = await run(base);

const paths = Object.keys(results.node);
let same = 0; const diffs = [];
console.log('request                                    node            durable object');
console.log('-----------------------------------------  --------------  --------------');
for (const path of paths) {
  const a = results.node[path];
  const b = results.durableObject[path];
  const match = a.status === b.status && a.keys === b.keys;
  if (match) same += 1; else diffs.push({ path, a, b });
  console.log(`${match ? ' ' : '!'}${path.padEnd(42)} ${String(a.status).padEnd(15)} ${String(b.status)}`);
}
console.log(`\n${same}/${paths.length} requests behave identically`);
for (const d of diffs) {
  console.log(`\nDIFFERENT: ${d.path}`);
  console.log(`  node:           ${d.a.status}  keys=${d.a.keys}`);
  console.log(`  durable object: ${d.b.status}  keys=${d.b.keys}`);
}
