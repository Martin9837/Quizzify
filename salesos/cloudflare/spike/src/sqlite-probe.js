import { DurableObject } from 'cloudflare:workers';

/**
 * The question this spike answers: can the SalesOS server run inside a
 * Durable Object without rewriting its data layer?
 *
 * Three things have to be true. The SQL API must be genuinely synchronous, so
 * the 478 `get`/`all`/`run` call sites keep their signatures. FTS5 must exist,
 * or global search has no home. And transactionSync must actually roll back,
 * or the transaction() helper is a lie.
 */
export class AppObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  async probe() {
    const checks = [];
    const ok = (name, good, detail = '') => checks.push({ name, ok: Boolean(good), detail: String(detail) });

    // -- 1. is exec() synchronous, or a promise wearing a cursor's clothes? --
    this.sql.exec('CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, name TEXT, org TEXT, tags TEXT)');
    const returned = this.sql.exec("INSERT INTO leads VALUES ('l1','Dana Reyes','org1','[\"vip\",\"warm\"]')");
    ok('exec() returns a cursor, not a Promise', typeof returned?.then !== 'function', typeof returned);

    // The shape the codebase relies on: a value read straight out, no await.
    const row = this.sql.exec('SELECT name FROM leads WHERE id = ?', 'l1').one();
    ok('a row reads synchronously with no await', row.name === 'Dana Reyes', JSON.stringify(row));
    const list = [...this.sql.exec('SELECT id, name FROM leads')];
    ok('.toArray()/iteration is synchronous too', list.length === 1, JSON.stringify(list));

    // -- 2. FTS5, the one extension global search cannot do without --------
    try {
      this.sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
        organization_id UNINDEXED, entity_type UNINDEXED, entity_id UNINDEXED,
        title, body, tokenize = 'porter unicode61')`);
      this.sql.exec(
        "INSERT INTO search_index VALUES ('org1','lead','l1','Dana Reyes','Acme renewal, budget approved')",
      );
      const hits = [...this.sql.exec(
        `SELECT entity_id, snippet(search_index, 4, '[', ']', '...', 8) AS excerpt, bm25(search_index) AS rank
         FROM search_index WHERE search_index MATCH ? ORDER BY rank`,
        'budget',
      )];
      ok('FTS5 with the porter tokenizer works', hits.length === 1, JSON.stringify(hits[0]));
      ok('bm25() and snippet() are available', hits[0]?.excerpt?.includes('[') && typeof hits[0].rank === 'number',
        JSON.stringify(hits[0]));
    } catch (error) {
      ok('FTS5 with the porter tokenizer works', false, error.message);
    }

    // -- 3. JSON1, for the json_each filters on tags and objections --------
    try {
      const tagged = [...this.sql.exec(
        "SELECT l.id FROM leads l WHERE EXISTS (SELECT 1 FROM json_each(l.tags) WHERE json_each.value = ?)", 'vip',
      )];
      ok('json_each filters work', tagged.length === 1, JSON.stringify(tagged));
    } catch (error) {
      ok('json_each filters work', false, error.message);
    }

    // -- 4. does transactionSync actually roll back? -----------------------
    try {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("INSERT INTO leads VALUES ('l2','Rolled Back','org1','[]')");
        throw new Error('deliberate');
      });
      ok('transactionSync propagates the error', false, 'it swallowed the throw');
    } catch (error) {
      ok('transactionSync propagates the error', error.message === 'deliberate', error.message);
    }
    const survived = this.sql.exec("SELECT COUNT(*) AS n FROM leads WHERE id = 'l2'").one().n;
    ok('a failed transactionSync rolled the write back', survived === 0, `${survived} rows survived`);

    // A committing transaction must keep its writes.
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO leads VALUES ('l3','Committed','org1','[]')");
    });
    ok('a committing transactionSync keeps its writes',
      this.sql.exec("SELECT COUNT(*) AS n FROM leads WHERE id = 'l3'").one().n === 1);

    // -- 5. foreign keys, which 31 ON DELETE CASCADEs depend on ------------
    const fk = this.sql.exec('PRAGMA foreign_keys').one();
    ok('foreign key enforcement is on', Object.values(fk)[0] === 1, JSON.stringify(fk));

    return { checks, passed: checks.filter((c) => c.ok).length, total: checks.length };
  }

  async fetch() {
    return Response.json(await this.probe());
  }
}

export default {
  async fetch(request, env) {
    const stub = env.APP.getByName('probe');
    return stub.fetch(request);
  },
};
