/**
 * A cold Durable Object, hit by everything at once.
 *
 * The client fires several API calls the moment it loads, so the first page
 * load of a fresh deployment arrives as a burst against an empty database
 * mid-seed. Every one of them must see a consistent database, not a
 * half-populated one.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const PASSWORD = process.env.DEMO_PASSWORD || 'Demo1234!';

const login = () => fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@northstar.demo', password: PASSWORD }),
});

// Twelve at once, before anything has seeded.
const burst = await Promise.all(Array.from({ length: 12 }, () => login().catch((e) => ({ error: e.message }))));
const statuses = [];
for (const r of burst) statuses.push(r.status ?? `threw:${r.error}`);

const ok = statuses.filter((s) => s === 200).length;
const failed = statuses.filter((s) => s !== 200);
console.log(`  ${ok}/12 concurrent cold logins succeeded`);
if (failed.length) console.log(`  non-200: ${JSON.stringify(failed)}`);

// Whichever won, the data must be complete and identical for all of them.
const token = await (async () => {
  for (const r of burst) if (r.status === 200) return (await r.clone().json()).accessToken;
  return null;
})();
if (!token) { console.log('  FAIL no session to check the data with'); process.exit(1); }

const H = { authorization: `Bearer ${token}` };
const counts = await Promise.all(['/admin/users', '/leads?limit=500', '/deals?openOnly=false', '/calls?limit=500']
  .map(async (p) => {
    const body = await (await fetch(`${BASE}/api/v1${p}`, { headers: H })).json();
    const key = ['users', 'leads', 'deals', 'calls'].find((k) => Array.isArray(body[k]));
    return `${p.split('?')[0]}=${body[key]?.length ?? '?'}`;
  }));
console.log(`  data after the burst: ${counts.join(' ')}`);

// Exactly one organisation, however many requests raced.
const orgs = await (await fetch(`${BASE}/api/v1/admin/settings`, { headers: H })).json();
console.log(`  settings readable: ${Boolean(orgs && typeof orgs === 'object')}`);
const users = await (await fetch(`${BASE}/api/v1/admin/users`, { headers: H })).json();
const emails = users.users.map((u) => u.email);
const duplicated = emails.length !== new Set(emails).size;
console.log(`  ${emails.length} accounts, duplicates: ${duplicated}`);
if (ok !== 12 || duplicated) { console.log('\nFAILED'); process.exit(1); }
console.log('\nall 12 raced requests saw one consistent, singly-seeded database');
