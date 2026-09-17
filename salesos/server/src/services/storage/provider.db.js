import { all, get, run, transaction } from '../../db/index.js';
import config from '../../config.js';
import { encryptBuffer, decryptBuffer, sha256 } from '../../lib/crypto.js';

/**
 * Recordings kept in the application's own database.
 *
 * The other drivers need something outside the process: a filesystem that
 * survives (which workerd does not have), or an S3/R2 bucket, which on
 * Cloudflare means enabling R2 on the account -- and that asks for a payment
 * method before it will store a single byte.
 *
 * On the deployed Worker this database *is* the Durable Object's SQLite, which
 * is already provisioned, already durable, and already paid for by the Workers
 * plan. It holds 10 GB, shared with the CRM data; the retention sweep deletes
 * recordings past their window, so the usage is bounded rather than
 * accumulating for ever.
 *
 * Audio is chunked because a single SQLite value on a Durable Object may not
 * exceed 2 MB. Chunks are bound as parameters, so the 100 KB limit on
 * statement *text* does not apply to them.
 *
 * This is not the best home for large media -- R2 is, and switching to it is
 * one variable once an account can enable it. It is the honest one for an
 * account that cannot.
 */

const CHUNK_BYTES = 512 * 1024;

export const databaseDriver = {
  name: 'database',

  async put(key, buffer, { contentType } = {}) {
    const payload = config.storage.encryptAtRest ? encryptBuffer(buffer) : buffer;
    const chunks = [];
    for (let offset = 0; offset < payload.length; offset += CHUNK_BYTES) {
      chunks.push(payload.subarray(offset, Math.min(offset + CHUNK_BYTES, payload.length)));
    }
    // An empty object still gets one row, so `exists` and `get` do not have to
    // treat "no chunks" as "not there".
    if (!chunks.length) chunks.push(Buffer.alloc(0));

    transaction(() => {
      run('DELETE FROM object_chunks WHERE key = ?', [key]);
      run('DELETE FROM object_meta WHERE key = ?', [key]);
      run(
        `INSERT INTO object_meta (key, content_type, bytes, stored_bytes, encrypted, checksum, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          key,
          contentType || 'application/octet-stream',
          buffer.length,
          payload.length,
          config.storage.encryptAtRest ? 1 : 0,
          sha256(buffer),
          new Date().toISOString(),
        ],
      );
      chunks.forEach((chunk, seq) => {
        run('INSERT INTO object_chunks (key, seq, chunk) VALUES (?, ?, ?)', [key, seq, Buffer.from(chunk)]);
      });
    });

    return { key, bytes: buffer.length, encrypted: config.storage.encryptAtRest };
  },

  async get(key) {
    const meta = get('SELECT * FROM object_meta WHERE key = ?', [key]);
    if (!meta) throw new Error(`Could not read ${key}: no such object`);
    const rows = all('SELECT chunk FROM object_chunks WHERE key = ? ORDER BY seq ASC', [key]);
    const sealed = Buffer.concat(rows.map((row) => Buffer.from(row.chunk)));
    return meta.encrypted ? decryptBuffer(sealed) : sealed;
  },

  async head(key) {
    const meta = get('SELECT * FROM object_meta WHERE key = ?', [key]);
    if (!meta) return null;
    return {
      key,
      contentType: meta.content_type || 'application/octet-stream',
      bytes: meta.bytes,
      storedBytes: meta.stored_bytes,
      encrypted: Boolean(meta.encrypted),
      checksum: meta.checksum || undefined,
      createdAt: meta.created_at,
    };
  },

  async delete(key) {
    // Deleting something already gone is a success, as it is everywhere else.
    transaction(() => {
      run('DELETE FROM object_chunks WHERE key = ?', [key]);
      run('DELETE FROM object_meta WHERE key = ?', [key]);
    });
    return true;
  },

  async exists(key) {
    return Boolean(get('SELECT key FROM object_meta WHERE key = ?', [key]));
  },
};

export default databaseDriver;
