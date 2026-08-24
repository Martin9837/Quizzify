/**
 * SalesOS service worker.
 *
 * Deliberately narrow. Its whole job is to make the app installable and to keep
 * the shell openable on a flaky mobile connection. It never caches /api or
 * /health: those carry bearer tokens and mutable CRM data, and a stale lead
 * record shown as current is worse than an honest network error.
 */

const VERSION = 'salesos-v3';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

// The HTML entry plus the icons the standalone UI needs before any JS runs.
// Hashed build output is not listed because its names only exist at build time;
// it is cached on first use instead.
const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png',
];

/**
 * The build emits content-hashed asset names, so they cannot be listed in this
 * file. Reading them straight out of the served HTML keeps the offline shell
 * honest without needing a build step to generate the worker: whatever index.html
 * actually references is what gets cached.
 */
async function cacheReferencedAssets(html) {
  const urls = [...new Set(
    [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]),
  )];
  if (!urls.length) return;
  const cache = await caches.open(ASSETS);
  await Promise.all(urls.map(async (url) => {
    try {
      if (await cache.match(url, MATCH)) return;
      const response = await fetch(url, { cache: 'reload' });
      if (response.ok) await cache.put(url, response);
    } catch {
      /* best effort -- a missing asset must not fail the install */
    }
  }));
}

async function precache() {
  const cache = await caches.open(SHELL);
  // One at a time so a single 404 cannot fail the whole install.
  await Promise.all(SHELL_URLS.map(async (url) => {
    try {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (!response.ok) return;
      await cache.put(url, response.clone());
      // The entry document names the JS and CSS the shell cannot boot without.
      if (url === '/') await cacheReferencedAssets(await response.text());
    } catch {
      /* offline at install time is survivable; the runtime paths refill it */
    }
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

const isPrivate = (url) => url.pathname.startsWith('/api/') || url.pathname === '/health';

/**
 * Every cache read passes ignoreVary. Static responses arrive with
 * `Vary: Accept-Encoding`, and these entries are keyed by URL string rather than
 * by the original Request, so a default match compares the request's
 * Accept-Encoding against a key that has no headers at all and misses every
 * time. That failure is invisible while online -- the network quietly answers
 * instead -- and only shows up as a blank app offline.
 */
const MATCH = { ignoreVary: true };

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Anything carrying auth or CRM state, and anything cross-origin (the webfont
  // CDN), is left entirely to the browser and the network.
  if (isPrivate(url) || url.origin !== self.location.origin) return;

  // Navigations: network first, so a new deploy is picked up on the next launch,
  // falling back to the cached shell when offline. React Router resolves the
  // path itself once the shell boots, so every route can be served from '/'.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(SHELL);
        await cache.put('/', fresh.clone());
        // A deploy changes every asset hash, so refresh the offline asset set
        // from the document that was just served. Off the critical path.
        event.waitUntil(fresh.clone().text().then(cacheReferencedAssets).catch(() => {}));
        return fresh;
      } catch {
        return (await caches.match('/', { cacheName: SHELL, ...MATCH })) || Response.error();
      }
    })());
    return;
  }

  // Build output under /assets/ is content-hashed, so a cache hit is always the
  // right answer and never needs revalidating.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const hit = await caches.match(request, { cacheName: ASSETS, ...MATCH });
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) (await caches.open(ASSETS)).put(request, response.clone());
      return response;
    })());
    return;
  }

  // Everything else static (icons, manifest): fresh when reachable, cached when
  // not.
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) (await caches.open(SHELL)).put(request, response.clone());
      return response;
    } catch {
      return (await caches.match(request, MATCH)) || Response.error();
    }
  })());
});
