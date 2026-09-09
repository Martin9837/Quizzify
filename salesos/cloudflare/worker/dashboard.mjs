// The dashboard as a user gets it: static assets and API from the same Worker.
//
// Every route the SPA actually declares, and each one is required NOT to be the
// client's own "Page not found" screen -- an earlier version of this check
// passed a 404 page because it only asserted the text was long enough.
import { chromium } from 'playwright-core';

// `CHROMIUM_PATH` points at a browser that is already on the machine; without
// it, playwright-core resolves whichever Chromium it installed itself.
const launch = {
  args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
};

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

let pass = 0; const fails = [];
const ok = (n, good, d = '') => { if (good) { pass++; console.log(`  ok    ${n}${d ? '   ' + d : ''}`); } else { fails.push(n); console.log(`  FAIL  ${n}   ${d}`); } };

const consoleErrors = [];
const failed = [];
// The webfont is external and unreachable from this sandbox; the SSE stream is
// aborted by the browser on every navigation, which is how SSE ends.
// The webfont is external and unreachable from this sandbox.
const expectedUrl = /fonts\.googleapis|fonts\.gstatic|favicon/i;
// ERR_ABORTED is the browser cancelling a request -- navigating away from a
// page with polling in flight, or closing an SSE stream. It is never the server
// failing, so it is excluded by reason rather than by a list of paths that
// would need extending every time a page gains a fetch.
const expectedReason = /ERR_ABORTED/i;
page.on('console', (m) => { if (m.type() === 'error' && !/CONNECTION_RESET|fonts|favicon/i.test(m.text())) consoleErrors.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 160)}`));
page.on('requestfailed', (r) => {
  const reason = r.failure()?.errorText || '';
  if (expectedUrl.test(r.url()) || expectedReason.test(reason)) return;
  failed.push(`${r.url().replace(BASE, '')} ${reason}`);
});
const apiOrigins = new Set();
page.on('request', (r) => { if (r.url().includes('/api/')) { try { apiOrigins.add(new URL(r.url()).origin); } catch {} } });

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
ok('the login page loads from the Worker', (await page.title()).includes('SalesOS'), await page.title());

await page.fill('input[type=email]', 'admin@northstar.demo');
await page.fill('input[type=password]', 'Demo1234!');
await page.click('button[type=submit]');
await page.waitForSelector('.sidebar', { timeout: 30000 });
ok('signing in works against the same-origin API', true);

const ROUTES = ['/', '/leads', '/companies', '/pipeline', '/calls', '/conversations',
  '/inbox', '/tasks', '/calendar', '/activity', '/insights', '/approvals',
  '/analytics', '/team', '/coaching', '/admin'];

for (const path of ROUTES) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  const state = await page.evaluate(() => {
    const body = document.body.innerText;
    // The shell (sidebar, search) is always present, so measure the content area.
    const main = document.querySelector('main') || document.querySelector('.content');
    const content = (main?.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      notFound: /that route does not exist|page not found/i.test(body),
      spinning: /^\s*loading/i.test(content) || /loading (leads|deals|calls|conversations|tasks)/i.test(content),
      broke: /something went wrong|failed to load|could not reach that address/i.test(body),
      chars: content.length,
      blocks: (main || document.body).querySelectorAll('table tbody tr, .card, .stat, [class*="kanban"], [class*="column"], .empty').length,
    };
  });
  ok(`${path} renders`,
    !state.notFound && !state.spinning && !state.broke && state.chars > 60,
    `${state.chars} chars, ${state.blocks} blocks`
    + `${state.notFound ? ', CLIENT 404' : ''}${state.spinning ? ', STILL LOADING' : ''}${state.broke ? ', ERROR' : ''}`);
}

// A deep link typed straight into the bar, which is what the SPA fallback is for.
await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const deep = await page.evaluate(() => ({
  onLogin: /sign in/i.test(document.body.innerText.slice(0, 300)),
  notFound: /that route does not exist/i.test(document.body.innerText),
  users: document.querySelectorAll('table tbody tr').length,
}));
ok('a deep link survives a full page load', !deep.onLogin && !deep.notFound, `${deep.users} user rows`);

for (const [path, shot] of [['/admin', 'cf-admin'], ['/pipeline', 'cf-pipeline'], ['/', 'cf-dashboard']]) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `shots/${shot}.png` });
}

// The home dashboard is personal -- "Calls today", "Who to call today", your
// quota -- so an admin who owns no leads sees zeros, correctly. The figures
// belong to whoever does the selling, so that is who the check signs in as.
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.evaluate(() => { try { localStorage.clear(); } catch {} });
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[type=email]', 'agent@northstar.demo');
await page.fill('input[type=password]', 'Demo1234!');
await page.click('button[type=submit]');
await page.waitForSelector('.sidebar', { timeout: 30000 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
const figures = await page.evaluate(() => {
  const main = document.querySelector('main') || document.body;
  return (main.innerText.match(/[\d,]+/g) || []).filter((n) => Number(n.replace(/,/g, '')) > 0).length;
});
ok("an agent's dashboard shows real figures", figures > 3, `${figures} non-zero numbers`);
await page.screenshot({ path: 'shots/cf-dashboard-agent.png' });

ok('every API request went to the page origin', apiOrigins.size === 1 && [...apiOrigins][0] === BASE,
  [...apiOrigins].join(', ') || 'none');
ok('no unexpected request failed', failed.length === 0, failed.slice(0, 3).join(' | '));
ok('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

console.log(`\n${pass}/${pass + fails.length} dashboard checks passed`);
if (fails.length) console.log('failures: ' + fails.join('; '));
await browser.close();
