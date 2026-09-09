import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, login, ACCOUNTS } from './helpers.js';
import { purgeDemoData, countRows } from '../src/db/purge.js';
import { get, all } from '../src/db/index.js';

before(start);
after(stop);

describe('purging the demo data', () => {
  it('empties every table but leaves one organisation and one usable account', async () => {
    // The seed is present, so there is something to remove.
    const before = countRows();
    assert.ok(before.leads > 10, `expected a seeded database, found ${before.leads} leads`);
    assert.ok(before.users > 1, `expected several users, found ${before.users}`);

    const admin = await login(ACCOUNTS.admin);
    const keeper = get('SELECT id, email FROM users WHERE email = ?', [ACCOUNTS.admin]);

    const result = purgeDemoData({ keepUserId: keeper.id });

    const after = countRows();
    for (const [table, n] of Object.entries(after)) {
      // Sessions are the exception on purpose: the kept account's own session
      // survives so the purge does not sign the operator out.
      if (['organizations', 'users', 'sessions'].includes(table)) continue;
      assert.equal(n, 0, `${table} still has ${n} rows after the purge`);
    }
    assert.equal(after.organizations, 1);
    assert.equal(after.users, 1);
    assert.equal(
      all('SELECT user_id FROM sessions').every((row) => row.user_id === keeper.id),
      true,
      'a session belonging to a deleted user survived',
    );
    assert.equal(result.keptUser.email, ACCOUNTS.admin);

    // The whole point: the account that was kept can still be used.
    const again = await login(ACCOUNTS.admin);
    assert.ok(again.token, 'the kept account can no longer sign in');

    // And the API answers on an empty database rather than erroring.
    for (const path of ['/leads', '/deals', '/calls', '/tasks', '/companies',
      '/conversations', '/notifications', '/admin/users', '/analytics/dashboard']) {
      const response = await again.api.get(path);
      assert.equal(response.status, 200, `${path} returned ${response.status} on an empty database`);
    }

    // Search must not return records that no longer exist.
    const search = await again.api.get('/search?q=a');
    assert.equal(search.status, 200);
    assert.equal(JSON.stringify(search.body).includes('lead_'), false,
      'search still returns purged records');
  });

  it('refuses when it would leave nobody able to sign in', () => {
    // Every account is gone at this point except the one kept above, so
    // pointing the purge at an account that does not exist must refuse rather
    // than delete that last one too.
    for (const target of [{ keepUserId: 'user_does_not_exist' }, { keepUserEmail: 'nobody@example.com' }]) {
      assert.throws(
        () => purgeDemoData(target),
        (error) => {
          assert.equal(error.status, 400, `expected a client error, got ${error.status}`);
          // The message has to name what was asked for; "no account to keep"
          // alone leaves the operator guessing which value was wrong.
          assert.match(error.message, /Refusing to purge/);
          assert.match(error.message, new RegExp(Object.values(target)[0]));
          return true;
        },
      );
      assert.equal(countRows().users, 1, 'a refusal must not delete anything');
    }
  });

  it('renames the organisation and the account when asked', () => {
    const result = purgeDemoData({ organizationName: 'Snappy LLC', adminName: 'Martin' });
    assert.equal(get('SELECT name FROM organizations WHERE id = ?', [result.organizationId]).name, 'Snappy LLC');
    assert.equal(get('SELECT name FROM users WHERE id = ?', [result.keptUser.id]).name, 'Martin');
    assert.equal(all('SELECT id FROM users').length, 1);
  });
});
