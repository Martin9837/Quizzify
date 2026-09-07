import { DurableObject } from 'cloudflare:workers';
import { setDriver, migrate, all, get, run, transaction, insert, hydrate } from '../../../server/src/db/index.js';
import { createDurableObjectDriver } from '../../../server/src/db/driver.do.js';
// The real file, not a copy -- a duplicate would drift silently.
import schema from '../../../server/src/db/schema.sql';

/**
 * The real data layer, unmodified, running on a Durable Object.
 *
 * Not a re-implementation: this imports `server/src/db/index.js` and the real
 * 634-line `schema.sql`. If the seam works, the helpers behave here exactly as
 * they do on Node, and nothing above them needs to know which engine it got.
 */
export class RealDb extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    setDriver(createDurableObjectDriver(ctx.storage, { schema }));
  }

  async fetch() {
    const checks = [];
    const ok = (name, good, detail = '') => checks.push({ name, ok: Boolean(good), detail: String(detail).slice(0, 200) });

    try {
      migrate(schema);
      const tables = all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).map((r) => r.name);
      ok('the real 634-line schema applies', tables.length >= 30, `${tables.length} tables created`);
      ok('the FTS5 virtual table is among them',
        tables.includes('search_index'), tables.filter((t) => t.includes('search')).join(','));
    } catch (error) {
      ok('the real 634-line schema applies', false, error.message);
      return Response.json({ checks, passed: 0, total: checks.length });
    }

    // A Durable Object keeps its storage between runs, including between
    // `wrangler dev` sessions, so the probe clears its own rows to stay
    // re-runnable. Deleting the organisation cascades to everything under it.
    try {
      run('DELETE FROM organizations WHERE id = ?', ['org_1']);
      run('DELETE FROM jobs');
      run('DELETE FROM search_index');
      ok('the probe can re-run against persisted storage', true);
    } catch (error) {
      ok('the probe can re-run against persisted storage', false, error.message);
    }

    // ---- insert() and the parameter coercion above the driver -------------
    try {
      insert('organizations', {
        id: 'org_1', name: 'Northstar', slug: 'northstar', plan: 'pro', seats: 10,
        settings: JSON.stringify({ crmApproval: { mode: 'suggestion' } }),
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      const org = get('SELECT * FROM organizations WHERE id = ?', ['org_1']);
      ok('insert() then get() round-trips', org?.name === 'Northstar', JSON.stringify(org?.name));
      ok('a plain object comes back, not a null-prototype row',
        Object.getPrototypeOf(org) === Object.prototype);

      // normalise() turns booleans, dates, arrays and objects into bindable
      // values, and that coercion lives above the driver, so it must still hold.
      insert('users', {
        id: 'usr_1', organization_id: 'org_1', email: 'a@b.c', name: 'Dana',
        password_hash: 'x', role: 'admin', status: 'active',
        created_at: new Date(), updated_at: new Date(),
      });
      const user = get('SELECT created_at FROM users WHERE id = ?', ['usr_1']);
      ok('a Date parameter is coerced to an ISO string',
        typeof user?.created_at === 'string' && user.created_at.includes('T'), String(user?.created_at));
    } catch (error) {
      ok('insert() and parameter coercion work', false, error.message);
    }

    // ---- run().changes, which the queue's atomic claim depends on ---------
    try {
      for (const n of [1, 2, 3]) {
        insert('jobs', {
          id: `job_${n}`, organization_id: 'org_1', type: 'test', payload: '{}',
          status: 'pending', priority: 5, attempts: 0, max_attempts: 3,
          run_after: new Date().toISOString(),
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
      }
      const claim = run(
        `UPDATE jobs SET status = 'running', locked_by = ? WHERE id = ? AND status = 'pending'`,
        ['w1', 'job_1'],
      );
      ok('a successful guarded UPDATE reports changes = 1', claim.changes === 1, `changes=${claim.changes}`);

      // The second worker must lose: the row is no longer pending.
      const lost = run(
        `UPDATE jobs SET status = 'running', locked_by = ? WHERE id = ? AND status = 'pending'`,
        ['w2', 'job_1'],
      );
      ok('a losing guarded UPDATE reports changes = 0 -- no double claim',
        lost.changes === 0, `changes=${lost.changes}`);

      const many = run("UPDATE jobs SET priority = 1 WHERE status = 'pending'");
      ok('changes counts every row a multi-row UPDATE touched', many.changes === 2, `changes=${many.changes}`);

      const none = run("UPDATE jobs SET priority = 9 WHERE id = 'nope'");
      ok('changes is 0 when nothing matched', none.changes === 0, `changes=${none.changes}`);
    } catch (error) {
      ok('run().changes is accurate', false, error.message);
    }

    // ---- transaction(), used in three places ------------------------------
    try {
      try {
        transaction(() => {
          run("UPDATE organizations SET name = 'Rolled Back' WHERE id = 'org_1'");
          throw new Error('deliberate');
        });
        ok('transaction() propagates the error', false, 'it swallowed the throw');
      } catch (error) {
        ok('transaction() propagates the error', error.message === 'deliberate', error.message);
      }
      ok('a failed transaction() rolled the write back',
        get('SELECT name FROM organizations WHERE id = ?', ['org_1'])?.name === 'Northstar',
        get('SELECT name FROM organizations WHERE id = ?', ['org_1'])?.name);

      transaction(() => { run("UPDATE organizations SET plan = 'enterprise' WHERE id = 'org_1'"); });
      ok('a committing transaction() keeps its writes',
        get('SELECT plan FROM organizations WHERE id = ?', ['org_1'])?.plan === 'enterprise');
    } catch (error) {
      ok('transaction() works', false, error.message);
    }

    // ---- the foreign key translation in run() -----------------------------
    try {
      insert('leads', {
        id: 'lead_bad', organization_id: 'org_1', first_name: 'X',
        owner_id: 'usr_does_not_exist',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      ok('a dangling foreign key is rejected', false, 'the write was accepted');
    } catch (error) {
      ok('a dangling foreign key becomes a 400, not a 500',
        error.status === 400 || /does not exist/i.test(error.message), `${error.status} ${error.message}`);
    }

    // ---- FTS5 through the real search projection --------------------------
    try {
      run(`INSERT INTO search_index (organization_id, entity_type, entity_id, owner_id, lead_id, occurred_at, title, body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['org_1', 'lead', 'lead_1', 'usr_1', 'lead_1', new Date().toISOString(),
          'Dana Reyes', 'Acme renewal, budget approved for Q3']);
      const hits = all(
        `SELECT entity_id, snippet(search_index, 7, '[', ']', '...', 18) AS excerpt, bm25(search_index) AS rank
         FROM search_index WHERE organization_id = ? AND search_index MATCH ? ORDER BY rank LIMIT ?`,
        ['org_1', '"budget"', 10],
      );
      ok('the real FTS5 query shape works', hits.length === 1 && hits[0].excerpt.includes('['),
        JSON.stringify(hits[0]));
    } catch (error) {
      ok('the real FTS5 query shape works', false, error.message);
    }

    // ---- json_each, used by the tag and objection filters -----------------
    try {
      insert('leads', {
        id: 'lead_1', organization_id: 'org_1', first_name: 'Dana', last_name: 'Reyes',
        tags: ['vip', 'warm'], owner_id: 'usr_1', do_not_call: true,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      const stored = get('SELECT do_not_call FROM leads WHERE id = ?', ['lead_1']);
      ok('a boolean parameter is coerced to 1', stored?.do_not_call === 1, JSON.stringify(stored?.do_not_call));
      const tagged = all(
        `SELECT l.id FROM leads l WHERE l.organization_id = ?
         AND EXISTS (SELECT 1 FROM json_each(l.tags) WHERE json_each.value = ?)`,
        ['org_1', 'vip'],
      );
      ok('json_each filters work, with the array coerced by normalise()',
        tagged.length === 1, JSON.stringify(tagged));
      const lead = hydrate(get('SELECT * FROM leads WHERE id = ?', ['lead_1']), ['tags']);
      ok('hydrate() parses the JSON column back out',
        Array.isArray(lead.tags) && lead.tags[0] === 'vip', JSON.stringify(lead.tags));
    } catch (error) {
      ok('json_each and hydrate() work', false, error.message);
    }

    // ---- ON DELETE CASCADE, which 31 columns rely on ----------------------
    try {
      run('DELETE FROM organizations WHERE id = ?', ['org_1']);
      const orphans = get('SELECT COUNT(*) AS n FROM users WHERE organization_id = ?', ['org_1']).n;
      ok('ON DELETE CASCADE removed the dependent rows', orphans === 0, `${orphans} users survived`);
    } catch (error) {
      ok('ON DELETE CASCADE works', false, error.message);
    }

    return Response.json({ checks, passed: checks.filter((c) => c.ok).length, total: checks.length });
  }
}

export default {
  fetch(request, env) {
    return env.REALDB.getByName('t1').fetch(request);
  },
};
