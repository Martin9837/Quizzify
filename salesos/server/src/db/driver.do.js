/**
 * The same contract over a Durable Object's embedded SQLite.
 *
 * This is the only storage on Cloudflare that keeps the data layer
 * synchronous: `ctx.storage.sql.exec()` returns a cursor rather than a
 * promise, and `ctx.storage.transactionSync()` exists for precisely this. So
 * none of the 478 call sites above this file change.
 *
 * Verified against workerd rather than assumed -- see `cloudflare/README.md`.
 *
 * Install it from the Durable Object's constructor, before anything reads:
 *
 *   import { setDriver } from './db/index.js';
 *   import { createDurableObjectDriver } from './db/driver.do.js';
 *   import schema from './db/schema.sql';   // bundled as text
 *   setDriver(createDurableObjectDriver(ctx.storage, { schema }));
 */

/** Split a multi-statement script, ignoring semicolons inside literals. */
function statements(script) {
  const out = [];
  let current = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < script.length; i += 1) {
    const char = script[i];
    const next = script[i + 1];

    if (lineComment) {
      current += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      current += char;
      if (char === '*' && next === '/') { current += next; i += 1; blockComment = false; }
      continue;
    }
    if (!quote && char === '-' && next === '-') { current += char; lineComment = true; continue; }
    if (!quote && char === '/' && next === '*') { current += char; blockComment = true; continue; }

    if (quote) {
      current += char;
      // '' inside a single-quoted string is an escaped quote, not the end.
      if (char === quote) {
        if (char === "'" && next === "'") { current += next; i += 1; continue; }
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === ';') { out.push(current); current = ''; continue; }
    current += char;
  }
  out.push(current);
  // Drop anything that is only whitespace or comments -- exec rejects those.
  return out.map((statement) => statement.trim()).filter((s) => withoutComments(s).length > 0);
}

/** The statement with its comments removed, for deciding what it is. */
function withoutComments(statement) {
  return statement
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();
}

export function createDurableObjectDriver(storage, { schema } = {}) {
  const sql = storage.sql;

  return {
    name: 'durable-object',

    // Handed to migrate() on first use, since there is no file to read.
    schema,

    open() { return sql; },
    isOpen() { return true; },
    handle() { return sql; },

    all(sqlText, params) {
      return [...sql.exec(sqlText, ...params)];
    },

    get(sqlText, params) {
      // `.one()` throws when there is no row; `node:sqlite` returns undefined,
      // and every caller here is written against undefined.
      for (const row of sql.exec(sqlText, ...params)) return row;
      return undefined;
    },

    run(sqlText, params) {
      const cursor = sql.exec(sqlText, ...params);
      // Drain the cursor so the statement has certainly run -- `RETURNING`
      // makes a write produce rows, and an undrained cursor would leave them.
      for (const _row of cursor) { /* discard */ }
      // `cursor.rowsWritten` counts index rows too, so it is not `changes()`.
      // The queue's atomic claim turns on this number being exact, and a
      // Durable Object is single-threaded, so nothing can modify the count
      // between the write and this read.
      return {
        changes: Number(sql.exec('SELECT changes() AS changes').one().changes),
        lastInsertRowid: undefined,
      };
    },

    exec(script) {
      // The schema arrives as one script; DO SQLite binds parameters only for a
      // single statement, so it is split and run in order.
      for (const statement of statements(script)) {
        // A Durable Object manages its own journal and always enforces foreign
        // keys, so the two PRAGMAs at the top of the schema have nothing to set
        // here. Skipping them is not a workaround -- WAL and a busy timeout
        // exist to coordinate concurrent writers, and the object is
        // single-threaded, which is a stronger guarantee than either.
        // Tested against the comment-stripped statement: schema.sql opens with a
        // comment banner, so the PRAGMA is not at the start of the text.
        const bare = withoutComments(statement);
        if (/^PRAGMA\s+(journal_mode|busy_timeout|foreign_keys)\b/i.test(bare)) continue;
        try {
          sql.exec(statement);
        } catch (error) {
          // A script failure is otherwise reported with no indication of which
          // of 77 statements was rejected.
          const first = statement.split('\n')
            .map((line) => line.trim())
            .find((line) => line && !line.startsWith('--')) ?? statement.trim();
          error.message = `${error.message} -- while running: ${first.slice(0, 160)}`;
          throw error;
        }
      }
    },

    transaction(fn) {
      // Synchronous, and documented as being for exactly this: it commits on
      // return and rolls back if the callback throws.
      return storage.transactionSync(fn);
    },

    close() { /* the object owns its storage; there is nothing to close */ },
  };
}

export default createDurableObjectDriver;
