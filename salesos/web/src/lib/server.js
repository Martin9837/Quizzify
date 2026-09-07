/**
 * Where the API lives.
 *
 * In a browser the client is served by the same process as the API, so an empty
 * origin -- meaning ordinary relative URLs -- is correct, and there is nothing
 * for anyone to configure. That path is unchanged.
 *
 * Inside the native shell the web assets are loaded out of the app bundle over
 * capacitor://localhost, so there is no API on this origin at all. The base has
 * to be an absolute URL pointing at whichever SalesOS server this install talks
 * to, which only the person installing it knows. They enter it once and it is
 * remembered here.
 */

const KEY = 'salesos.server';

/**
 * True only inside the Capacitor shell. Read off the global the native runtime
 * injects rather than importing @capacitor/core, so the browser bundle carries
 * no trace of it.
 */
export function isNativeShell() {
  try {
    return globalThis.window?.Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/**
 * Where the API is, for a browser build.
 *
 * Served by the API itself -- `npm start`, or the dev proxy -- the two share an
 * origin and relative URLs are right, which is the default. Deployed as static
 * files to a CDN (Cloudflare Pages, S3, Netlify) the client and the API are on
 * different origins, so the base has to be baked in at build time:
 *
 *   VITE_API_BASE=https://api.example.com npm run build
 *
 * Whatever is set must be reachable from a browser and must list this origin in
 * the server's WEB_ORIGINS, or every request will be refused by CORS.
 */
const BUILD_TIME_BASE = (import.meta.env?.VITE_API_BASE || '').replace(/\/+$/, '');

/** '' when the API shares this origin; an absolute origin otherwise. */
export function getServerOrigin() {
  // The native shell asks the user, because a bundle on a phone cannot know
  // which server it belongs to. That choice outranks a build-time default.
  if (isNativeShell()) {
    try {
      return localStorage.getItem(KEY) || '';
    } catch {
      return '';
    }
  }
  return BUILD_TIME_BASE;
}

/**
 * Accepts what someone would actually type -- `10.0.0.4:4000`,
 * `https://sales.example.com/` -- and stores a bare origin. Throws on input
 * that is not a URL at all, so the setup screen can say so before saving.
 */
export const DEFAULT_API_PORT = '4000';

export function normaliseServerOrigin(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Enter your server address.');
  const hadScheme = /^https?:\/\//i.test(raw);
  let url;
  try {
    url = new URL(hadScheme ? raw : `http://${raw}`);
  } catch {
    throw new Error('That does not look like a server address.');
  }
  if (!url.hostname) throw new Error('That does not look like a server address.');

  // A bare host with no port used to resolve to port 80, where a self-hosted
  // SalesOS is never listening -- so leaving the port off failed with an error
  // about the server rather than about the missing port. Fill in the port the
  // app actually defaults to.
  //
  // Only for a bare host: someone who typed a scheme is pointing at a proper
  // origin (a reverse proxy on https://sales.example.com has no port, and
  // forcing 4000 onto it would break a working address).
  if (!url.port && !hadScheme) url.port = DEFAULT_API_PORT;

  return url.origin;
}

export function setServerOrigin(input) {
  const origin = normaliseServerOrigin(input);
  localStorage.setItem(KEY, origin);
  return origin;
}

export function clearServerOrigin() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

/** The native shell cannot do anything useful until a server is set. */
export function needsServerConfig() {
  return isNativeShell() && !getServerOrigin();
}

/**
 * Confirms something is actually listening before we commit to an address, so a
 * typo fails on the setup screen rather than as a wall of errors afterwards.
 */
export async function probeServer(origin, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}/health`, { signal: controller.signal });
    if (!response.ok) return { ok: false, error: `${origin} answered with ${response.status}.` };
    const body = await response.json();
    if (!body?.status) return { ok: false, error: `Something is running at ${origin}, but it is not a SalesOS server.` };
    return { ok: true, version: body.version, status: body.status };
  } catch (error) {
    // Always name the address that was actually tried. The input is normalised
    // before it gets here -- a port is filled in, a scheme is added -- so an
    // error that does not echo the result leaves someone checking an address
    // the app never used. The likeliest cause goes first: on a self-hosted app
    // the port is wrong or missing far more often than CORS is misconfigured.
    return {
      ok: false,
      error: error.name === 'AbortError'
        ? `No answer from ${origin}. Check your phone and the server are on the same network.`
        : `Could not reach ${origin}. Check the server is running and that this is the `
          + `port it printed on startup, then that your phone is on the same network as it.`,
    };
  } finally {
    clearTimeout(timer);
  }
}
