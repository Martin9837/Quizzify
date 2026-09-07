import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import logger from '../lib/logger.js';

/**
 * The default engine: a local SQLite file through `node:sqlite`.
 *
 * This is the whole of what used to live inline in `db/index.js`. It is a
 * driver now only so that a second engine can exist -- see `driver.do.js` --
 * not because anything about this one changed.
 */

let database = null;

export const nodeDriver = {
  name: 'node:sqlite',

  open() {
    if (database) return database;
    const file = config.db.file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    database = new DatabaseSync(file);
    database.exec('PRAGMA foreign_keys = ON');
    // Write-ahead logging lets readers run while a write is in progress, and
    // the busy timeout absorbs the contention that remains.
    if (file !== ':memory:') database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA busy_timeout = 5000');
    return database;
  },

  isOpen() {
    return database !== null;
  },

  /** The native handle, for the two places that want to talk to SQLite directly. */
  handle() {
    return this.open();
  },

  all(sql, params) {
    return this.open().prepare(sql).all(...params);
  },

  get(sql, params) {
    return this.open().prepare(sql).get(...params);
  },

  run(sql, params) {
    return this.open().prepare(sql).run(...params);
  },

  exec(sql) {
    return this.open().exec(sql);
  },

  transaction(fn) {
    const db = this.open();
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
  },

  close() {
    if (database) {
      database.close();
      database = null;
    }
  },
};

export default nodeDriver;
