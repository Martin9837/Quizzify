/**
 * API client.
 *
 * Handles token storage, transparent refresh on 401, and a single error shape
 * so every screen can render failures the same way. One in-flight refresh is
 * shared between concurrent requests so a burst of 401s produces one refresh.
 */

import { getServerOrigin } from './server.js';

const BASE = '/api/v1';
const ACCESS_KEY = 'salesos.access';
const REFRESH_KEY = 'salesos.refresh';

let accessToken = safeRead(ACCESS_KEY);
let refreshToken = safeRead(REFRESH_KEY);
let refreshInFlight = null;
const listeners = new Set();

function safeRead(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeWrite(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode) -- tokens stay in memory only */
  }
}

export function setTokens({ accessToken: access, refreshToken: refresh }) {
  if (access !== undefined) {
    accessToken = access;
    safeWrite(ACCESS_KEY, access);
  }
  if (refresh !== undefined) {
    refreshToken = refresh;
    safeWrite(REFRESH_KEY, refresh);
  }
}

export function clearTokens() {
  accessToken = null;
  refreshToken = null;
  safeWrite(ACCESS_KEY, null);
  safeWrite(REFRESH_KEY, null);
}

export const getAccessToken = () => accessToken;
export const hasSession = () => Boolean(accessToken);

/** Notified when the session ends so the app can return to the login screen. */
export function onAuthLost(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.error?.code;
    this.details = payload?.error?.details;
    this.requestId = payload?.requestId;
  }
}

async function refreshSession() {
  if (!refreshToken) return false;
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${getServerOrigin()}${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
      .then(async (response) => {
        if (!response.ok) return false;
        const data = await response.json();
        setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function request(method, path, { body, query, signal, raw = false, retry = true } = {}) {
  // getServerOrigin() is '' in a browser, so this stays a relative URL resolved
  // against the page. In the native shell it is absolute, and the second
  // argument is then ignored -- the app bundle's own origin serves no API.
  const url = new URL(`${getServerOrigin()}${BASE}${path}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
  }

  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (response.status === 401 && retry && refreshToken) {
    const refreshed = await refreshSession();
    if (refreshed) return request(method, path, { body, query, signal, raw, retry: false });
    clearTokens();
    for (const listener of listeners) listener();
    throw new ApiError(401, { error: { code: 'unauthorized', message: 'Your session has expired. Please sign in again.' } });
  }

  if (raw) {
    if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => ({})));
    return response;
  }

  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

export const api = {
  get: (path, query, options) => request('GET', path, { query, ...options }),
  post: (path, body, options) => request('POST', path, { body, ...options }),
  patch: (path, body, options) => request('PATCH', path, { body, ...options }),
  put: (path, body, options) => request('PUT', path, { body, ...options }),
  del: (path, options) => request('DELETE', path, options),
  raw: (path, query) => request('GET', path, { query, raw: true }),

  async login({ email, password, organizationSlug }) {
    const data = await request('POST', '/auth/login', {
      body: { email, password, organizationSlug },
      retry: false,
    });
    setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
    return data;
  },

  async logout() {
    try {
      await request('POST', '/auth/logout', { body: { refreshToken } });
    } catch {
      /* signing out locally matters more than the server acknowledging it */
    }
    clearTokens();
  },

  /** Download a report as a file without leaving the page. */
  async download(path, query, filename) {
    const response = await request('GET', path, { query, raw: true });
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
  },
};

export default api;
