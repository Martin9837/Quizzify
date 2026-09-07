import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../lib/logger.js';
import { badRequest } from '../lib/errors.js';
import { nodeDriver } from './driver.node.js';


/**
 * Every read and write in the codebase goes through the five primitives below,
 * so the storage engine is one assignment rather than 478 edits.
 *
 * The default is a local SQLite file. The other implementation is a Durable
 * Object's embedded SQLite (`driver.do.js`), which is the only storage on
 * Cloudflare that is still synchronous -- which is what lets this seam be this
 * thin. A driver supplies `all`/`get`/`run`/`exec`/`transaction` plus
 * `open`/`close`; the JSON handling, the parameter coercion and the constraint
 * translation below are engine-independent and stay here.
 */
let driver = nodeDriver;
let migrated = false;

/** Swap the engine. Call it before the first read -- a Durable Object does this
 *  from its constructor. */
export function setDriver(next) {
  driver = next;
  migrated = false;
  logger.debug('database driver installed', { driver: next.name });
  return driver;
}

export function activeDriver() {
  return driver;
}

export function getDb() {
  const handle = driver.open();
  // The schema is applied on first use, as it always was.
  if (!migrated) migrate(driver.schema);
  return handle;
}

/**
 * Apply the schema.
 *
 * The SQL can be passed in, because not every host has a filesystem to read it
 * from: on Workers `node:fs` is a memory-backed virtual FS, so a Durable Object
 * bundles `schema.sql` as a string and hands it over instead.
 */
export function migrate(schemaSql) {
  // A driver that was handed its schema supplies it, so a caller does not have
  // to know which engine is installed -- `seed()` calls this with no argument.
  // The filesystem is the last resort, and the path is resolved here rather
  // than at module scope: `import.meta.url` is undefined on Workers, and
  // computing it eagerly threw before any code could run.
  const schema = schemaSql
    ?? driver.schema
    ?? fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'),
      'utf8',
    );
  driver.exec(schema);
  migrated = true;
  return driver.handle ? driver.handle() : driver;
}

export function closeDb() {
  driver.close();
  migrated = false;
}

// --------------------------------------------------------------- helpers ----
// node:sqlite returns null-prototype objects; copy into plain objects so the
// rest of the codebase (and JSON.stringify of nested values) behaves normally.
const plain = (row) => (row ? { ...row } : row);

export function all(sql, params = []) {
  ensureReady();
  return driver.all(sql, normalise(params)).map(plain);
}

export function get(sql, params = []) {
  ensureReady();
  const row = driver.get(sql, normalise(params));
  return row ? plain(row) : undefined;
}

/**
 * A write, with one error translated.
 *
 * Several fields on create and update payloads are ids the caller supplies:
 * ownerId on a lead or deal, leadId on a task, teamId on a user. A well-formed
 * id that simply does not exist used to reach SQLite and come back as an
 * unhandled `FOREIGN KEY constraint failed`, which the error handler could only
 * report as a 500 -- telling a client its own bad input was a server fault, and
 * logging a stack trace for something that is not a defect.
 *
 * Translating it here rather than adding an existence check to each route means
 * the guarantee holds for every write, including ones written later. Routes that
 * want a more specific message (`notFound('Lead')`, say) still check first and
 * are unaffected; this is the floor, not the policy.
 *
 * If our own code ever inserts a genuinely bad reference this returns 400 rather
 * than 500, which slightly understates a real bug -- but the message is accurate
 * either way and the detail is still logged, which beats a stack trace reaching
 * the client.
 */
export function run(sql, params = []) {
  ensureReady();
  try {
    return driver.run(sql, normalise(params));
  } catch (error) {
    if (/FOREIGN KEY constraint failed/i.test(error.message)) {
      logger.debug('foreign key constraint rejected a write', { sql: sql.slice(0, 120) });
      throw badRequest('One of the records this refers to does not exist. Check any id you supplied.');
    }
    throw error;
  }
}

export function exec(sql) {
  ensureReady();
  return driver.exec(sql);
}

export function transaction(fn) {
  ensureReady();
  return driver.transaction(fn);
}

/** Open the engine and apply the schema once, on the first query of the process. */
function ensureReady() {
  if (!migrated) getDb();
}

// SQLite only accepts null/number/bigint/string/Buffer. Booleans, dates,
// arrays and objects are converted here so callers can stay expressive.
function normalise(params) {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
  });
}

/** Build `INSERT INTO table (...) VALUES (...)` from an object. */
export function insert(table, data) {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  run(sql, keys.map((k) => data[k]));
  return data.id;
}

/** Build a scoped `UPDATE`. Always requires an organization_id for isolation. */
export function update(table, id, organizationId, data) {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined && k !== 'id');
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND organization_id = ?`;
  const result = run(sql, [...keys.map((k) => data[k]), id, organizationId]);
  return result.changes;
}

export function upsert(table, data, conflictKeys) {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  const updates = keys.filter((k) => !conflictKeys.includes(k) && k !== 'id');
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})
    ON CONFLICT (${conflictKeys.join(', ')}) DO UPDATE SET ${updates.map((k) => `${k} = excluded.${k}`).join(', ')}`;
  run(sql, keys.map((k) => data[k]));
}

/**
 * `column IN (...)` for a list of any length, as a single bound parameter.
 *
 * Expanding a list into `?, ?, ?` costs one bound parameter per element, and
 * the hosted SQLite engines cap a statement at 100 of them -- so a scoped query
 * broke once an organisation had ~97 users, and a client could breach it
 * outright by sending 200 notification ids. `json_each` takes the list as one
 * JSON parameter instead, however long it is.
 *
 * Checked against EXPLAIN QUERY PLAN: the index is still used
 * (`SEARCH leads USING INDEX idx_leads_owner (organization_id=? AND
 * owner_id=?)`), so this is not a trade of a ceiling for a table scan.
 *
 * An empty list yields a clause that matches nothing, which is what every
 * caller wanted and had to write by hand.
 */
export function inList(column, values) {
  const list = [...new Set(values ?? [])];
  if (!list.length) return { sql: `${column} IN (SELECT value FROM json_each('[]'))`, params: [] };
  return { sql: `${column} IN (SELECT value FROM json_each(?))`, params: [list] };
}

// ------------------------------------------------------- JSON convenience ---
export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Hydrate the listed JSON columns on a row (or array of rows) in place. */
export function hydrate(row, jsonFields = [], defaults = {}) {
  if (!row) return row;
  if (Array.isArray(row)) return row.map((r) => hydrate(r, jsonFields, defaults));
  const out = { ...row };
  for (const field of jsonFields) {
    out[field] = parseJson(out[field], defaults[field] !== undefined ? defaults[field] : []);
  }
  return out;
}

export default {
  getDb, migrate, closeDb, setDriver, activeDriver,
  all, get, run, exec, transaction, insert, update, upsert, inList, parseJson, hydrate,
};
