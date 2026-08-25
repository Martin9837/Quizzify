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

/** '' in the browser (relative URLs); an absolute origin in the native shell. */
export function getServerOrigin() {
  if (!isNativeShell()) return '';
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

/**
 * Accepts what someone would actually type -- `10.0.0.4:4000`,
 * `https://sales.example.com/` -- and stores a bare origin. Throws on input
 * that is not a URL at all, so the setup screen can say so before saving.
 */
export function normaliseServerOrigin(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Enter your server address.');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('That does not look like a server address.');
  }
  if (!url.hostname) throw new Error('That does not look like a server address.');
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
    if (!response.ok) return { ok: false, error: `The server answered with ${response.status}.` };
    const body = await response.json();
    if (!body?.status) return { ok: false, error: 'That address answered, but it is not a SalesOS server.' };
    return { ok: true, version: body.version, status: body.status };
  } catch (error) {
    return {
      ok: false,
      error: error.name === 'AbortError'
        ? 'No answer from that address. Check the app and the server are on the same network.'
        // A CORS refusal and a dead host are indistinguishable to fetch, so name
        // both causes rather than guessing at one. WEB_ORIGINS is the setting
        // that bites a self-hoster whose server is otherwise fine.
        : 'Could not reach that address. Check the server is running, and that it '
          + 'allows this app in its WEB_ORIGINS setting.',
    };
  } finally {
    clearTimeout(timer);
  }
}
