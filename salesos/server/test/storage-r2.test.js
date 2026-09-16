import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The R2 *binding* driver, against a stand-in bucket implementing the parts of
 * the R2 API the driver uses. Its own file because config.js reads
 * STORAGE_DRIVER once at import, and the S3 test sets it to something else.
 *
 * The point of the stand-in is the contract: R2 hands back objects, not HTTP
 * responses, custom metadata is strings only, and a missing object is `null`
 * rather than a 404 to check.
 */

const stored = new Map();

const bucket = {
  async put(key, value, options = {}) {
    // R2 accepts ArrayBuffer, a view, a string, a stream or a Blob. A Node
    // Buffer arrives as a view; anything else here would be a driver bug.
    assert.ok(ArrayBuffer.isView(value), `put() must pass bytes, got ${typeof value}`);
    for (const [k, v] of Object.entries(options.customMetadata || {})) {
      assert.equal(typeof v, 'string', `customMetadata.${k} must be a string, got ${typeof v}`);
    }
    stored.set(key, {
      body: Buffer.from(value),
      httpMetadata: options.httpMetadata || {},
      customMetadata: options.customMetadata || {},
      uploaded: new Date('2026-09-16T10:00:00.000Z'),
    });
    return { key, size: value.byteLength };
  },
  async get(key) {
    const object = stored.get(key);
    if (!object) return null;
    return {
      key,
      size: object.body.length,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      uploaded: object.uploaded,
      async arrayBuffer() {
        return object.body.buffer.slice(object.body.byteOffset, object.body.byteOffset + object.body.length);
      },
    };
  },
  async head(key) {
    const object = stored.get(key);
    if (!object) return null;
    return {
      key,
      size: object.body.length,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      uploaded: object.uploaded,
    };
  },
  async delete(key) {
    stored.delete(key);
  },
};

let storage;
let r2;

before(async () => {
  process.env.STORAGE_DRIVER = 'r2binding';
  process.env.STORAGE_ENCRYPT_AT_REST = 'true';
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
  storage = await import('../src/services/storage/index.js');
  r2 = await import('../src/services/storage/provider.r2.js');
});

describe('R2 binding object storage', () => {
  const key = 'org_test/recordings/2026-09-16/call_1 (final)+v2.audio';
  const audio = Buffer.from('RIFF....this is the recording payload....', 'utf8');

  it('refuses to pretend it stored anything when no bucket is bound', async () => {
    // The failure that matters. Falling back to the local driver on workerd
    // writes to a memory-backed filesystem that is gone at the end of the
    // request, so a recording would be reported as stored and then not exist.
    r2.setBucket(null);
    await assert.rejects(
      () => storage.putObject(key, audio, { contentType: 'audio/wav' }),
      (error) => {
        assert.match(error.message, /No R2 bucket is bound/);
        return true;
      },
    );
  });

  it('stores, and reports the plaintext size rather than the sealed size', async () => {
    r2.setBucket(bucket);
    const result = await storage.putObject(key, audio, { contentType: 'audio/wav' });
    assert.equal(result.bytes, audio.length);
    assert.equal(result.encrypted, true);

    const head = await storage.headObject(key);
    assert.equal(head.bytes, audio.length, 'head must report the size the caller stored');
    assert.ok(head.storedBytes > audio.length, 'the sealed blob is larger than the plaintext');
    assert.equal(head.encrypted, true);
    assert.equal(head.contentType, 'audio/wav');
    assert.equal(head.createdAt, '2026-09-16T10:00:00.000Z');
  });

  it('encrypts before the bytes leave the process', () => {
    const raw = stored.get(key).body;
    assert.equal(raw.includes('this is the recording payload'), false,
      'the recording was written to the bucket in plaintext');
  });

  it('round-trips the exact bytes', async () => {
    const read = await storage.getObject(key);
    assert.deepEqual(read, audio);
  });

  it('answers exists honestly, and reports a missing object as an error', async () => {
    assert.equal(await storage.objectExists(key), true);
    assert.equal(await storage.objectExists('org_test/nothing/here.audio'), false);
    assert.equal(await storage.headObject('org_test/nothing/here.audio'), null);
    await assert.rejects(() => storage.getObject('org_test/nothing/here.audio'), /no such object/);
  });

  it('deletes, and treats a second delete as done rather than an error', async () => {
    assert.equal(await storage.deleteObject(key), true);
    assert.equal(await storage.objectExists(key), false);
    assert.equal(await storage.deleteObject(key), true);
  });
});
