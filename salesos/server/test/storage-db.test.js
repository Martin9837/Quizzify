import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Recordings kept in the application's own database -- the driver an account
 * that cannot enable R2 has to fall back on, and the one the deployed Worker
 * uses, where this database is the Durable Object's SQLite.
 *
 * No Express app here on purpose: helpers.js imports it at module load, which
 * freezes config.js before a test body can choose a storage driver.
 */

let storage;
let db;

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_FILE = ':memory:';
  process.env.STORAGE_DRIVER = 'database';
  process.env.STORAGE_ENCRYPT_AT_REST = 'true';
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
  process.env.LOG_LEVEL = 'error';
  db = await import('../src/db/index.js');
  db.getDb();
  storage = await import('../src/services/storage/index.js');
});

describe('recordings stored in the database', () => {
  const key = 'org_test/recordings/2026-09-17/call_1 (final)+v2.audio';
  // Larger than one chunk, so the splitting and reassembly are exercised
  // rather than assumed: a Durable Object refuses a value over 2 MB.
  const audio = Buffer.concat([
    Buffer.from('RIFF....this is the recording payload....', 'utf8'),
    Buffer.alloc(1_400_000, 0x33),
  ]);

  it('stores and reports the plaintext size, not the sealed size', async () => {
    const result = await storage.putObject(key, audio, { contentType: 'audio/wav' });
    assert.equal(result.bytes, audio.length);
    assert.equal(result.encrypted, true);

    const head = await storage.headObject(key);
    assert.equal(head.bytes, audio.length, 'head must report the size the caller stored');
    assert.ok(head.storedBytes > audio.length, 'the sealed blob is larger than the plaintext');
    assert.equal(head.contentType, 'audio/wav');
    assert.ok(head.createdAt, 'a stored object needs a timestamp');
  });

  it('splits it into chunks no Durable Object would refuse', () => {
    const rows = db.all('SELECT seq, length(chunk) AS bytes FROM object_chunks WHERE key = ? ORDER BY seq', [key]);
    assert.ok(rows.length > 1, `a 1.4 MB recording should span several chunks, got ${rows.length}`);
    for (const row of rows) {
      assert.ok(row.bytes <= 512 * 1024, `chunk ${row.seq} is ${row.bytes} bytes`);
      assert.ok(row.bytes < 2_000_000, 'a Durable Object refuses a value over 2 MB');
    }
  });

  it('round-trips the exact bytes', async () => {
    const read = await storage.getObject(key);
    assert.equal(read.length, audio.length);
    assert.deepEqual(read, audio);
  });

  it('encrypts before the bytes reach the table', () => {
    const first = db.all('SELECT chunk FROM object_chunks WHERE key = ? ORDER BY seq LIMIT 1', [key])[0];
    assert.equal(Buffer.from(first.chunk).includes('this is the recording payload'), false,
      'the recording was written to the database in plaintext');
  });

  it('replaces rather than accumulates when the same key is written twice', async () => {
    const chunksBefore = db.all('SELECT seq FROM object_chunks WHERE key = ?', [key]).length;
    await storage.putObject(key, Buffer.from('a much shorter take', 'utf8'), { contentType: 'audio/wav' });
    const chunksAfter = db.all('SELECT seq FROM object_chunks WHERE key = ?', [key]).length;
    assert.ok(chunksAfter < chunksBefore, 'the previous chunks were left behind');
    assert.deepEqual(await storage.getObject(key), Buffer.from('a much shorter take', 'utf8'));
  });

  it('answers exists honestly and reports a missing object as an error', async () => {
    assert.equal(await storage.objectExists(key), true);
    assert.equal(await storage.objectExists('org_test/nothing/here.audio'), false);
    assert.equal(await storage.headObject('org_test/nothing/here.audio'), null);
    await assert.rejects(() => storage.getObject('org_test/nothing/here.audio'), /no such object/);
  });

  it('deletes both the chunks and the metadata, twice over', async () => {
    assert.equal(await storage.deleteObject(key), true);
    assert.equal(await storage.objectExists(key), false);
    assert.equal(db.all('SELECT seq FROM object_chunks WHERE key = ?', [key]).length, 0,
      'chunks outlived the object they belonged to');
    assert.equal(await storage.deleteObject(key), true);
  });
});
