import { all, get, run, transaction } from './index.js';
import logger from '../lib/logger.js';
import { badRequest } from '../lib/errors.js';

/**
 * Empty the database of everything except one organisation and one account.
 *
 * The demo seed is convenient for a first look and useless afterwards: 64
 * leads, 44 deals, a hundred calls and nine colleagues who do not exist. This
 * removes all of it while leaving a way back in -- delete the last account and
 * the deployment becomes unreachable, because the only way to create a user is
 * to already be signed in as one.
 *
 * Every table is cleared explicitly rather than left to `ON DELETE CASCADE`.
 * Cascade would do most of it, but five tables hang off nothing
 * (`audit_logs`, `jobs`, `ai_usage`, `ai_conversations`) or are virtual
 * (`search_index`), so relying on it would leave residue that is invisible
 * until someone searches for a lead that no longer exists.
 */

/**
 * Cleared completely. Ordered children-first so the result is the same whether
 * or not foreign keys are enforced, which is not true of every host.
 */
const EMPTIED = [
  // call and conversation history
  'call_events', 'transcripts', 'call_analyses', 'calls',
  // pipeline
  'deal_stage_history', 'deals',
  // engagement
  'messages', 'emails', 'meetings', 'notes', 'tasks', 'activities', 'notifications',
  // records
  'ai_suggestions', 'leads', 'companies',
  // configuration the seed invented
  'webhook_deliveries', 'webhooks', 'integrations', 'assignment_rules',
  'custom_field_defs', 'api_keys',
  // people
  'teams',
  // not reachable from organizations by any cascade
  'audit_logs', 'jobs', 'ai_usage', 'ai_conversations',
];

/**
 * Kept, but reduced. `organizations` and `users` to a single row each;
 * `sessions` to whatever belongs to the account being kept -- deleting those
 * would sign the operator out mid-purge, which is a surprising way for a
 * cleanup to behave.
 */
const REDUCED = ['organizations', 'users', 'sessions'];

export function purgeDemoData({ keepUserId, keepUserEmail, organizationName, adminName } = {}) {
  // Name the survivor. Guessing gets this wrong in a way that is not obvious
  // afterwards: preferring the highest role picks the super_admin, which on a
  // seeded database is not the account anyone has actually been signing in
  // with -- so the purge succeeds and the operator is locked out of the only
  // login they know.
  let keeper;
  if (keepUserId) keeper = get('SELECT * FROM users WHERE id = ?', [keepUserId]);
  else if (keepUserEmail) keeper = get('SELECT * FROM users WHERE email = ?', [keepUserEmail]);
  else {
    keeper = get(`SELECT * FROM users WHERE role IN ('super_admin', 'admin')
                  ORDER BY CASE role WHEN 'super_admin' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`);
    if (keeper) {
      logger.warn('no account named to keep; keeping the highest-ranking admin', { email: keeper.email });
    }
  }

  if (!keeper) {
    const asked = keepUserEmail || keepUserId;
    throw badRequest(asked
      ? `Refusing to purge: no account matches ${asked}, and deleting the rest would leave nobody able to sign in.`
      : 'Refusing to purge: there is no admin account to keep, so nobody could sign in afterwards.');
  }

  const before = countRows();
  let after;

  transaction(() => {
    for (const table of EMPTIED) emptyTable(table);

    run('DELETE FROM users WHERE id != ?', [keeper.id]);
    run('DELETE FROM organizations WHERE id != ?', [keeper.organization_id]);
    // Everyone else's sessions go; the keeper stays signed in.
    run('DELETE FROM sessions WHERE user_id != ?', [keeper.id]);

    // The team it belonged to is gone.
    run('UPDATE users SET team_id = NULL, updated_at = ? WHERE id = ?',
      [new Date().toISOString(), keeper.id]);

    if (adminName) {
      run('UPDATE users SET name = ?, updated_at = ? WHERE id = ?',
        [adminName, new Date().toISOString(), keeper.id]);
    }
    if (organizationName) {
      run('UPDATE organizations SET name = ?, updated_at = ? WHERE id = ?',
        [organizationName, new Date().toISOString(), keeper.organization_id]);
    }

    // Rebuilt from nothing, since every indexed record is gone. Kept out of the
    // table list because dropping rows from an FTS5 table needs its own delete.
    emptyTable('search_index');

    // Verified before committing, not after. Checking afterwards meant an
    // incomplete purge had already been written, while the caller was told
    // nothing had changed -- the worst combination of the two.
    after = countRows();
    const residue = Object.entries(after)
      .filter(([table, n]) => n > 0 && !REDUCED.includes(table))
      .map(([table, n]) => `${table}=${n}`);

    const strayLogins = get(
      'SELECT COUNT(*) AS n FROM sessions WHERE user_id != ?', [keeper.id],
    )?.n ?? 0;
    if (strayLogins) residue.push(`sessions belonging to deleted users=${strayLogins}`);

    if (residue.length) {
      // A table added to the schema later and not listed above lands here
      // rather than being silently left full.
      throw new Error(`Purge left rows behind in ${residue.join(', ')}; rolled back`);
    }
  });

  logger.info('demo data purged', {
    keptUser: keeper.email,
    keptOrganization: keeper.organization_id,
    removed: Object.entries(before)
      .filter(([, n]) => n > 0)
      .reduce((total, [, n]) => total + n, 0),
  });

  return {
    keptUser: { id: keeper.id, email: keeper.email, role: keeper.role },
    organizationId: keeper.organization_id,
    before,
    after,
  };
}

/**
 * Empty one table, saying which one if the engine refuses.
 *
 * Hosted SQLite engines apply an authorizer, and a rejection surfaces only as
 * `not authorized: SQLITE_AUTH` with no indication of the statement -- which
 * against a list of thirty tables says nothing at all.
 */
function emptyTable(table) {
  try {
    run(`DELETE FROM ${table}`);
  } catch (error) {
    error.message = `${error.message} -- while emptying ${table}`;
    throw error;
  }
}

/** Row counts for every table in the schema, so the result can be asserted. */
export function countRows() {
  let tables;
  try {
    // Anything with a leading underscore belongs to the runtime, not to this
    // schema. A Durable Object's sqlite_master lists Cloudflare's own tables
    // (`_cf_KV`, `_cf_METADATA`) and the local emulator adds its own
    // (`__miniflare_do_name`); counting a Cloudflare one is refused outright
    // with `not authorized: SQLITE_AUTH`. Plain node:sqlite has neither, so
    // counting everything sqlite_master reports passes locally and fails only
    // once deployed -- twice over, with a different table each time.
    //
    // GLOB rather than LIKE because `_` is a wildcard in LIKE, and escaping it
    // inside a template literal is its own trap: `ESCAPE '\'` collapses to an
    // empty string before SQLite ever sees it.
    tables = all(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT GLOB '_*'
         AND name NOT LIKE 'search_index%'`,
    ).map((row) => row.name);
  } catch (error) {
    error.message = `${error.message} -- while reading sqlite_master`;
    throw error;
  }
  const counts = {};
  for (const table of tables) {
    counts[table] = get(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
  }
  counts.search_index = get('SELECT COUNT(*) AS n FROM search_index')?.n ?? 0;
  return counts;
}

export default { purgeDemoData, countRows };
