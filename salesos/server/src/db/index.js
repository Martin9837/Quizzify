import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import logger from '../lib/logger.js';
import { badRequest } from '../lib/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let database = null;

export function getDb() {
  if (database) return database;
  const file = config.db.file;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  database = new DatabaseSync(file);
  database.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA busy_timeout = 5000');
  migrate(database);
  return database;
}

export function migrate(db = getDb()) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

export function closeDb() {
  if (database) {
    database.close();
    database = null;
  }
}

// --------------------------------------------------------------- helpers ----
// node:sqlite returns null-prototype objects; copy into plain objects so the
// rest of the codebase (and JSON.stringify of nested values) behaves normally.
const plain = (row) => (row ? { ...row } : row);

export function all(sql, params = []) {
  return getDb().prepare(sql).all(...normalise(params)).map(plain);
}

export function get(sql, params = []) {
  const row = getDb().prepare(sql).get(...normalise(params));
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
  try {
    return getDb().prepare(sql).run(...normalise(params));
  } catch (error) {
    if (/FOREIGN KEY constraint failed/i.test(error.message)) {
      logger.debug('foreign key constraint rejected a write', { sql: sql.slice(0, 120) });
      throw badRequest('One of the records this refers to does not exist. Check any id you supplied.');
    }
    throw error;
  }
}

export function exec(sql) {
  return getDb().exec(sql);
}

export function transaction(fn) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      logger.error('rollback failed', { error: rollbackError.message });
    }
    throw error;
  }
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

export default { getDb, migrate, closeDb, all, get, run, exec, transaction, insert, update, upsert, parseJson, hydrate };
