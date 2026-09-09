import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, login, ACCOUNTS } from './helpers.js';
import { purgeDemoData, resetSurvivorProfile, countRows } from '../src/db/purge.js';
import { get, all, run } from '../src/db/index.js';

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

    // Rows are not the only thing the seed wrote. Both survivors still carried
    // columns it invented -- a job title for a person who no longer exists, a
    // fake direct line, an enterprise plan nobody bought, and a monthly call
    // target of 420 that /analytics/dashboard divides by 21 and presents as
    // today's goal. Emptying the tables left all of it on screen.
    const survivor = get('SELECT * FROM users WHERE id = ?', [keeper.id]);
    assert.equal(survivor.title, null, `the seeded job title survived: ${survivor.title}`);
    assert.equal(survivor.phone, null, `the seeded phone number survived: ${survivor.phone}`);
    assert.equal(survivor.quota_amount, 0);
    assert.equal(survivor.team_id, null);
    assert.equal(survivor.timezone, 'UTC');
    assert.equal(survivor.preferences, '{}');
    assert.equal(survivor.last_login_at, null);
    // org:write, org:delete, billing:write and retention:write are
    // super_admin-only. Keeping an `admin` as the last account would leave
    // PATCH /admin/organization unreachable for good.
    assert.equal(survivor.role, 'super_admin');
    assert.equal(result.keptUser.role, 'super_admin');

    const org = get('SELECT * FROM organizations WHERE id = ?', [result.organizationId]);
    assert.equal(org.plan, 'growth', `the seeded plan survived: ${org.plan}`);
    assert.equal(org.seats, 10);
    assert.equal(org.timezone, 'UTC');
    // '{}' rather than the defaults spelled out: orgSettings() merges
    // DEFAULT_ORG_SETTINGS over what is stored, so empty *is* the defaults.
    assert.equal(org.settings, '{}', `the seeded org settings survived: ${org.settings}`);
    // Not renamed here, so the slug follows the name it still has -- but it is
    // recomputed rather than left as the seed's hand-written 'northstar'.
    assert.equal(org.slug, 'northstar-revenue');

    // The whole point: the account that was kept can still be used.
    const again = await login(ACCOUNTS.admin);
    assert.ok(again.token, 'the kept account can no longer sign in');

    // And the API answers on an empty database rather than erroring.
    for (const path of ['/leads', '/deals', '/calls', '/tasks', '/companies',
      '/conversations', '/notifications', '/admin/users', '/analytics/dashboard']) {
      const response = await again.api.get(path);
      assert.equal(response.status, 200, `${path} returned ${response.status} on an empty database`);
    }

    // The promotion has to be real, not just a column value: renaming the
    // organisation is super_admin-only, and it is the one owner-level action
    // an operator is most likely to want on a fresh account.
    const renamed = await again.api.patch('/admin/organization', { name: 'Acme Ltd' });
    assert.equal(renamed.status, 200, `renaming the organisation returned ${renamed.status}`);
    assert.equal(get('SELECT name FROM organizations').name, 'Acme Ltd');

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
    // The slug is UNIQUE and NOT NULL and was 'northstar'; a rename that left
    // it behind would keep the demo name in every place the slug is shown.
    assert.equal(get('SELECT slug FROM organizations WHERE id = ?', [result.organizationId]).slug, 'snappy-llc');
    assert.equal(all('SELECT id FROM users').length, 1);
  });

  it('cleans the surviving account a second time without deleting real records', async () => {
    // The purge is armed by a token in the deployment's configuration. Raising
    // that token to finish cleaning the two half-seeded survivor rows must not
    // empty the database a second time: by then everything in it was created
    // by the operator, and re-running the destructive pass would delete their
    // work while reporting a successful cleanup.
    const { api } = await login(ACCOUNTS.admin);
    const created = await api.post('/leads', {
      firstName: 'Real',
      lastName: 'Customer',
      companyName: 'Paying Client Ltd',
      email: 'real.customer@client.test',
    });
    assert.equal(created.status, 201);
    const leadId = created.body.lead.id;

    // Put the demo values back on the survivor, as the first pass used to leave them.
    run(`UPDATE users SET title = 'Revenue Operations Lead', phone = '+155501001', role = 'admin' WHERE id = ?`,
      [created.body.lead.ownerId]);
    run(`UPDATE organizations SET plan = 'enterprise', seats = 25, settings = '{"quotas":{"monthlyCallTarget":420}}'`);

    const result = resetSurvivorProfile({ organizationName: 'Second Pass Ltd', adminName: 'Owner' });

    const survivor = get('SELECT * FROM users WHERE id = ?', [result.keptUser.id]);
    assert.equal(survivor.title, null);
    assert.equal(survivor.phone, null);
    assert.equal(survivor.role, 'super_admin');
    assert.equal(survivor.name, 'Owner');
    const org = get('SELECT * FROM organizations');
    assert.equal(org.name, 'Second Pass Ltd');
    assert.equal(org.slug, 'second-pass-ltd');
    assert.equal(org.plan, 'growth');
    assert.equal(org.seats, 10);
    assert.equal(org.settings, '{}');

    // The point of the whole test.
    assert.equal(countRows().leads, 1, 'the second pass deleted a record it did not create');
    assert.ok(get('SELECT id FROM leads WHERE id = ?', [leadId]), 'the operator\'s lead is gone');

    // And it is still reachable through the API, not just present in a row.
    const fresh = await login(ACCOUNTS.admin);
    const list = await fresh.api.get('/leads');
    assert.equal(list.status, 200);
    assert.equal(list.body.leads.length, 1);
  });
});
