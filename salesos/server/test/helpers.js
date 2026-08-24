/**
 * Test harness. Every test file gets a fresh in-memory database and a real
 * Express app, so the suite exercises the same code path as production without
 * touching disk or the network.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = ':memory:';
process.env.JWT_SECRET = 'test-jwt-secret-value-for-signing-tokens';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-aes-gcm-tests';
process.env.QUEUE_ENABLED = 'false';
process.env.SCHEDULER_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.AI_PROVIDER = 'local';
process.env.TELEPHONY_PROVIDER = 'simulator';
process.env.EMAIL_PROVIDER = 'log';
process.env.STORAGE_ROOT = '/tmp/salesos-test-objects';

const { createApp } = await import('../src/app.js');
const { getDb } = await import('../src/db/index.js');
const { seed } = await import('../src/db/seed.js');
const { registerWorkers } = await import('../src/services/queue/workers.js');

let app;
let server;
let baseUrl;
let seeded;

export async function start() {
  if (baseUrl) return { baseUrl, seeded };
  getDb();
  registerWorkers();
  seeded = await seed({ reset: false });
  // Tests place and end a call in the same millisecond, so drop the
  // "too short to transcribe" floor that protects real deployments.
  const { updateSettings } = await import('../src/services/org.js');
  const { all } = await import('../src/db/index.js');
  for (const org of all('SELECT id FROM organizations')) {
    updateSettings(org.id, { transcription: { minimumCallSeconds: 0 } });
  }
  app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, seeded };
}

export async function stop() {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  baseUrl = null;
}

/** Thin fetch wrapper that mirrors the browser client. */
export function client(token) {
  const request = async (method, path, body) => {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    return { status: response.status, body: payload, ok: response.ok };
  };
  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
    del: (path) => request('DELETE', path),
    withToken: (next) => client(next),
  };
}

export async function login(email, password = 'Demo1234!') {
  const anonymous = client();
  const result = await anonymous.post('/auth/login', { email, password });
  if (!result.ok) throw new Error(`login failed for ${email}: ${JSON.stringify(result.body)}`);
  return { token: result.body.accessToken, user: result.body.user, api: client(result.body.accessToken) };
}

export const ACCOUNTS = {
  agent: 'agent@northstar.demo',
  otherAgent: 'bea@northstar.demo',
  manager: 'manager@northstar.demo',
  admin: 'admin@northstar.demo',
  owner: 'owner@northstar.demo',
};
