import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, client, login, ACCOUNTS } from './helpers.js';

before(start);
after(stop);

describe('authentication', () => {
  it('signs in a seeded user and returns permissions', async () => {
    const { user, token } = await login(ACCOUNTS.agent);
    assert.equal(user.email, ACCOUNTS.agent);
    assert.equal(user.role, 'agent');
    assert.ok(token.split('.').length === 3, 'expected a JWT');
    assert.ok(user.permissions.includes('call:place'));
    assert.ok(!user.permissions.includes('user:write'), 'an agent must not have admin permissions');
  });

  it('rejects a wrong password with the same message as an unknown user', async () => {
    const anonymous = client();
    const wrongPassword = await anonymous.post('/auth/login', { email: ACCOUNTS.agent, password: 'nope' });
    const unknownUser = await anonymous.post('/auth/login', { email: 'nobody@example.com', password: 'nope' });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.equal(wrongPassword.body.error.message, unknownUser.body.error.message);
  });

  it('refuses unauthenticated access to protected routes', async () => {
    const anonymous = client();
    const result = await anonymous.get('/leads');
    assert.equal(result.status, 401);
  });

  it('rotates the refresh token and invalidates the old one', async () => {
    const anonymous = client();
    const first = await anonymous.post('/auth/login', { email: ACCOUNTS.agent, password: 'Demo1234!' });
    const refreshed = await anonymous.post('/auth/refresh', { refreshToken: first.body.refreshToken });
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.body.accessToken);

    const reuse = await anonymous.post('/auth/refresh', { refreshToken: first.body.refreshToken });
    assert.equal(reuse.status, 401, 'a used refresh token must not work twice');
  });

  it('validates request bodies', async () => {
    const anonymous = client();
    const result = await anonymous.post('/auth/login', { email: 'not-an-email' });
    assert.equal(result.status, 422);
    assert.ok(Array.isArray(result.body.error.details));
  });
});
