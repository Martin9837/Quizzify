import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';

/**
 * The S3/R2 driver is exercised against a bucket that re-derives the SigV4
 * signature from the request it receives and rejects anything that does not
 * match. A mock that simply answered 200 would pass with a broken signer and
 * fail only against a real bucket, which is the one place it is expensive to
 * find out.
 */

const KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const BUCKET = 'salesos-recordings';

const objects = new Map();
const seen = [];
let server;
let storage;

/** The verification side, written from the SigV4 specification. */
function verify(req, bodyBuffer) {
  const auth = req.headers.authorization || '';
  const match = auth.match(
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/,
  );
  if (!match) return { ok: false, why: `unparseable Authorization header: ${auth.slice(0, 90)}` };
  const [, keyId, dateStamp, region, signedHeaders, signature] = match;
  if (keyId !== KEY_ID) return { ok: false, why: `wrong key id ${keyId}` };

  const names = signedHeaders.split(';');
  if (names.join(';') !== [...names].sort().join(';')) return { ok: false, why: `signed headers not sorted: ${signedHeaders}` };
  if (!names.includes('host')) return { ok: false, why: 'host is not signed' };
  if (!names.includes('x-amz-content-sha256')) return { ok: false, why: 'x-amz-content-sha256 is not signed' };

  const payloadHash = createHash('sha256').update(bodyBuffer).digest('hex');
  if (req.headers['x-amz-content-sha256'] !== payloadHash) {
    return { ok: false, why: `payload hash does not describe the body (${req.headers['x-amz-content-sha256']} vs ${payloadHash})` };
  }
  const amzDate = req.headers['x-amz-date'] || '';
  if (!/^\d{8}T\d{6}Z$/.test(amzDate)) return { ok: false, why: `bad x-amz-date ${amzDate}` };
  if (!amzDate.startsWith(dateStamp)) return { ok: false, why: 'credential scope date disagrees with x-amz-date' };

  const canonicalHeaders = names
    .map((name) => `${name}:${String(name === 'host' ? req.headers.host : req.headers[name]).trim()}`)
    .join('\n');
  const canonicalRequest = [
    req.method,
    new URL(req.url, 'http://placeholder').pathname,
    '',
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  let signing = createHmac('sha256', `AWS4${SECRET}`).update(dateStamp).digest();
  for (const part of [region, 's3', 'aws4_request']) signing = createHmac('sha256', signing).update(part).digest();
  const expected = createHmac('sha256', signing).update(stringToSign).digest('hex');

  return signature === expected
    ? { ok: true, region }
    : { ok: false, why: 'signature mismatch: the canonical request the client signed is not the request it sent' };
}

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const check = verify(req, body);
      seen.push({ method: req.method, url: req.url, ok: check.ok, why: check.why, region: check.region });
      if (!check.ok) {
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end(`<Error><Code>SignatureDoesNotMatch</Code><Message>${check.why}</Message></Error>`);
        return;
      }
      const path = new URL(req.url, 'http://placeholder').pathname;
      const prefix = `/${BUCKET}/`;
      if (!path.startsWith(prefix)) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end('<Error><Code>NoSuchBucket</Code></Error>');
        return;
      }
      const key = decodeURIComponent(path.slice(prefix.length));

      if (req.method === 'PUT') {
        objects.set(key, { body, headers: req.headers });
        res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` });
        res.end();
        return;
      }
      const stored = objects.get(key);
      if (!stored) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      const headers = {
        'content-type': stored.headers['content-type'] || 'application/octet-stream',
        'content-length': String(stored.body.length),
        'last-modified': 'Mon, 07 Sep 2026 12:00:00 GMT',
      };
      for (const name of ['x-amz-meta-bytes', 'x-amz-meta-encrypted', 'x-amz-meta-checksum']) {
        if (stored.headers[name]) headers[name] = stored.headers[name];
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : stored.body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // config.js reads the environment once at import, so it is set up first.
  process.env.STORAGE_DRIVER = 'r2';
  process.env.STORAGE_ENCRYPT_AT_REST = 'true';
  process.env.S3_BUCKET = BUCKET;
  process.env.S3_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  process.env.S3_ACCESS_KEY_ID = KEY_ID;
  process.env.S3_SECRET_ACCESS_KEY = SECRET;
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
  storage = await import('../src/services/storage/index.js');
});

after(() => new Promise((resolve) => server.close(resolve)));

describe('S3-compatible object storage', () => {
  const key = 'org_test/recordings/2026-09-07/call_1 (final)+v2.audio';
  const audio = Buffer.from('RIFF....this is the recording payload....', 'utf8');

  it('signs a request the bucket accepts', async () => {
    const result = await storage.putObject(key, audio, { contentType: 'audio/wav' });
    const put = seen.find((r) => r.method === 'PUT');
    assert.equal(put.ok, true, `bucket rejected the signature: ${put.why}`);
    assert.equal(result.bytes, audio.length);
  });

  it('uses the "auto" credential scope R2 requires when an endpoint is set', () => {
    assert.equal(seen.find((r) => r.method === 'PUT').region, 'auto');
  });

  it('encrypts the blob before it leaves the process', () => {
    const [stored] = [...objects.values()];
    assert.equal(stored.body.subarray(0, 4).toString(), 'SOS1', 'stored blob is not sealed');
    assert.ok(!stored.body.includes('this is the recording payload'), 'plaintext reached the bucket');
    assert.notEqual(stored.body.length, audio.length);
  });

  it('reports the plaintext size and checksum, not the sealed size', async () => {
    const head = await storage.headObject(key);
    assert.equal(head.bytes, audio.length);
    assert.equal(head.encrypted, true);
    assert.equal(head.contentType, 'audio/wav');
    assert.ok(head.storedBytes > audio.length, 'sealed size should exceed the plaintext');
    assert.equal(head.checksum, createHash('sha256').update(audio).digest('hex'));
    assert.equal(head.createdAt, '2026-09-07T12:00:00.000Z');
  });

  it('round-trips the exact bytes through a key needing percent-encoding', async () => {
    assert.deepEqual(await storage.getObject(key), audio);
  });

  it('answers exists honestly', async () => {
    assert.equal(await storage.objectExists(key), true);
    assert.equal(await storage.objectExists('org_test/nope.audio'), false);
  });

  it('reports a missing object as an error naming the bucket code', async () => {
    await assert.rejects(
      () => storage.getObject('org_test/missing.audio'),
      /NoSuchKey/,
    );
  });

  it('deletes, and treats a second delete as done rather than an error', async () => {
    assert.equal(await storage.deleteObject(key), true);
    assert.equal(await storage.objectExists(key), false);
    assert.equal(await storage.deleteObject(key), true);
  });

  it('never puts the secret key in an error message', async () => {
    const error = await storage.getObject('org_test/missing.audio').catch((e) => e);
    assert.ok(!error.message.includes(SECRET));
    assert.ok(!error.message.includes(KEY_ID));
  });

  it('names the missing environment variable when misconfigured', async () => {
    const { s3Driver } = await import('../src/services/storage/provider.s3.js');
    const config = (await import('../src/config.js')).default;
    const saved = config.storage.s3.secretAccessKey;
    config.storage.s3.secretAccessKey = '';
    await assert.rejects(() => s3Driver.exists('x'), /S3_SECRET_ACCESS_KEY/);
    config.storage.s3.secretAccessKey = saved;
  });

  it('rejected nothing the mock bucket checked', () => {
    const rejected = seen.filter((r) => !r.ok);
    assert.deepEqual(rejected, [], `signature failures: ${rejected.map((r) => `${r.method} ${r.why}`).join('; ')}`);
  });
});
