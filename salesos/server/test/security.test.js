import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, client, login, ACCOUNTS } from './helpers.js';
import { hashPassword, verifyPassword, signJwt, verifyJwt, encrypt, decrypt, encryptBuffer, decryptBuffer } from '../src/lib/crypto.js';
import { toE164, maskNumber, countryFromE164 } from '../src/lib/phone.js';
import { resolveConsentPolicy } from '../src/services/telephony/index.js';
import { DEFAULT_ORG_SETTINGS } from '../src/lib/constants.js';

before(start);
after(stop);

describe('cryptography', () => {
  it('hashes and verifies passwords without storing them', () => {
    const hash = hashPassword('correct horse battery staple');
    assert.ok(!hash.includes('correct'), 'the plaintext must not appear in the hash');
    assert.ok(verifyPassword('correct horse battery staple', hash));
    assert.ok(!verifyPassword('wrong password', hash));
  });

  it('produces a different hash for the same password (salted)', () => {
    assert.notEqual(hashPassword('same'), hashPassword('same'));
  });

  it('rejects a tampered JWT', () => {
    const token = signJwt({ sub: 'user_1', org: 'org_1' });
    assert.equal(verifyJwt(token).sub, 'user_1');
    const [header, claims, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'user_2', org: 'org_2', exp: 9999999999 })).toString('base64url');
    assert.throws(() => verifyJwt(`${header}.${forged}.${signature}`), /signature/i);
  });

  it('rejects an expired JWT', () => {
    const expired = signJwt({ sub: 'user_1' }, { expiresInSeconds: -10 });
    assert.throws(() => verifyJwt(expired), /expired/i);
  });

  it('round-trips encrypted credentials and detects tampering', () => {
    const secret = JSON.stringify({ accessToken: 'super-secret-token' });
    const sealed = encrypt(secret);
    assert.ok(!sealed.includes('super-secret'), 'the ciphertext must not leak the plaintext');
    assert.equal(decrypt(sealed), secret);

    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered payload').toString('base64url');
    assert.throws(() => decrypt(parts.join('.')));
  });

  it('encrypts recording buffers and leaves unencrypted buffers readable', () => {
    const audio = Buffer.from('pretend this is audio data');
    const sealed = encryptBuffer(audio);
    assert.notEqual(sealed.toString(), audio.toString());
    assert.equal(decryptBuffer(sealed).toString(), audio.toString());
    assert.equal(decryptBuffer(audio).toString(), audio.toString(), 'legacy plain buffers still read back');
  });
});

describe('phone handling', () => {
  it('normalises national numbers to E.164', () => {
    assert.equal(toE164('(555) 010-1234'), '+15550101234');
    assert.equal(toE164('020 7946 0958', 'GB'), '+442079460958');
    assert.equal(toE164('+49 30 1234567'), '+49301234567');
    assert.equal(toE164('00 33 1 42 68 53 00'), '+33142685300');
    assert.equal(toE164(''), null);
  });

  it('identifies the country from an E.164 number', () => {
    assert.equal(countryFromE164('+15550101234'), 'US');
    assert.equal(countryFromE164('+442079460958'), 'GB');
  });

  it('masks all but the last two digits', () => {
    const masked = maskNumber('+15550101234');
    assert.ok(masked.endsWith('34'));
    assert.ok(masked.includes('*'));
    assert.ok(!masked.includes('5550101'));
  });
});

describe('recording consent policy', () => {
  it('requires consent in an all-party region', () => {
    const policy = resolveConsentPolicy(DEFAULT_ORG_SETTINGS, { country: 'DE' });
    assert.equal(policy.mode, 'all_party');
    assert.equal(policy.requiresConsent, true);
  });

  it('honours a one-party regional override', () => {
    const policy = resolveConsentPolicy(DEFAULT_ORG_SETTINGS, { country: 'GB' });
    assert.equal(policy.mode, 'one_party');
    assert.equal(policy.requiresConsent, false);
  });

  it('reports recording as unavailable when the organisation disables it', () => {
    const policy = resolveConsentPolicy(
      { ...DEFAULT_ORG_SETTINGS, recording: { ...DEFAULT_ORG_SETTINGS.recording, enabled: false } },
      { country: 'US' },
    );
    assert.equal(policy.mode, 'disabled');
    assert.equal(policy.requiresConsent, false);
  });
});

describe('API hardening', () => {
  it('returns a structured error with a request id', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const result = await api.get('/leads/lead_does_not_exist');
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, 'not_found');
    assert.ok(result.body.requestId);
  });

  it('does not reveal whether a route exists to an anonymous caller', async () => {
    const anonymous = client();
    const result = await anonymous.get('/nope');
    // 401 rather than 404: an unauthenticated caller cannot enumerate routes.
    assert.equal(result.status, 401);
  });

  it('returns a helpful 404 for an unknown route when authenticated', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const result = await api.get('/definitely-not-a-route');
    assert.equal(result.status, 404);
    assert.match(result.body.error.message, /No route/);
  });

  it('rejects an invalid sort field instead of interpolating it', async () => {
    const { api } = await login(ACCOUNTS.agent);
    const result = await api.get('/leads?sort=' + encodeURIComponent('updated_at; DROP TABLE leads'));
    assert.equal(result.status, 400);
    const stillThere = await api.get('/leads?limit=1');
    assert.equal(stillThere.status, 200, 'the table should still exist');
  });

  it('never returns integration credentials', async () => {
    const { api } = await login(ACCOUNTS.admin);
    await api.post('/admin/integrations/slack', { credentials: { token: 'xoxb-secret-value' }, config: {} });
    const result = await api.get('/admin/integrations');
    const serialised = JSON.stringify(result.body);
    assert.ok(!serialised.includes('xoxb-secret-value'), 'credentials must never be returned by the API');
    const slack = result.body.integrations.find((entry) => entry.provider === 'slack');
    assert.equal(slack.hasCredentials, true);
  });

  it('shows an API key exactly once', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const key = await api.post('/admin/api-keys', { name: 'test key' });
    assert.equal(key.status, 201);
    assert.ok(key.body.key.startsWith('sos_'));

    const list = await api.get('/admin/api-keys');
    const serialised = JSON.stringify(list.body);
    assert.ok(!serialised.includes(key.body.key), 'the full key must not be retrievable afterwards');
  });

  it('authenticates with an API key', async () => {
    const { api } = await login(ACCOUNTS.admin);
    const key = await api.post('/admin/api-keys', { name: 'integration key' });
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/api/v1/leads?limit=1`, { headers: { 'x-api-key': key.body.key } });
    assert.equal(response.status, 200);

    const rejected = await fetch(`${baseUrl}/api/v1/leads`, { headers: { 'x-api-key': 'sos_invalid_key_value' } });
    assert.equal(rejected.status, 401);
  });

  it('sets baseline security headers', async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.ok(response.headers.get('x-request-id'));
  });

  it('reports health including the database and queue', async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.database, 'ok');
    assert.ok(body.queue.handlers > 0);
  });
});
