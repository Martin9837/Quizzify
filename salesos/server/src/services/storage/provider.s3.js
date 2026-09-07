import { createHash, createHmac } from 'node:crypto';
import config from '../../config.js';
import { encryptBuffer, decryptBuffer, sha256 } from '../../lib/crypto.js';

/**
 * S3-compatible object storage, signed with SigV4 over `fetch`.
 *
 * One driver covers AWS S3, Cloudflare R2, MinIO and the rest, because they all
 * speak the same signed HTTP API. It is written against `fetch` and
 * `node:crypto` rather than an SDK for two reasons: the SDK is a large
 * dependency for four verbs, and this way the same file runs unchanged on
 * Workers with `nodejs_compat`, where a filesystem does not exist at all.
 *
 * Encryption at rest is applied here, not left to the bucket: the blob is
 * sealed with AES-256-GCM before it leaves the process, so the storage provider
 * never holds a recording it could read. `decryptBuffer` recognises its own
 * header, so a bucket written with encryption off still reads back.
 */

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const hashHex = (payload) => createHash('sha256').update(payload).digest('hex');
const sign = (key, value) => createHmac('sha256', key).update(value).digest();

/** Percent-encode each path segment, leaving the separators intact. */
const encodeKey = (key) => key
  .split('/')
  .map((segment) => encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  ))
  .join('/');

const ENV_NAMES = {
  bucket: 'S3_BUCKET',
  accessKeyId: 'S3_ACCESS_KEY_ID',
  secretAccessKey: 'S3_SECRET_ACCESS_KEY',
  endpoint: 'S3_ENDPOINT',
};

/**
 * Fail loudly and specifically. A misconfigured bucket used to surface as a
 * generic "driver not configured", which says nothing about which value is
 * missing.
 */
function settings() {
  const s3 = config.storage.s3;
  const missing = ['bucket', 'accessKeyId', 'secretAccessKey']
    .filter((key) => !s3[key])
    .map((key) => ENV_NAMES[key]);
  if (missing.length) {
    throw new Error(`Object storage driver "${config.storage.driver}" needs ${missing.join(', ')}`);
  }
  // R2 has no regions and expects the literal "auto" in the credential scope.
  const region = s3.region || (s3.endpoint ? 'auto' : 'us-east-1');
  if (!s3.endpoint && !s3.region) {
    throw new Error(`Object storage needs ${ENV_NAMES.endpoint} or S3_REGION to know where the bucket lives`);
  }
  return { ...s3, region };
}

function objectUrl({ bucket, endpoint, region }, key) {
  const encoded = encodeKey(key);
  return new URL(endpoint
    // Path style: R2 and MinIO require it, and AWS still honours it.
    ? `${endpoint.replace(/\/+$/, '')}/${bucket}/${encoded}`
    : `https://${bucket}.s3.${region}.amazonaws.com/${encoded}`);
}

async function request(method, key, { body, headers = {} } = {}) {
  const cfg = settings();
  const url = objectUrl(cfg, key);
  const payloadHash = body ? hashHex(body) : EMPTY_SHA256;
  const amzDate = `${new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
  const dateStamp = amzDate.slice(0, 8);

  // `host` is signed but never sent: the runtime sets it from the URL, and
  // undici rejects an explicit one.
  const signed = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) signed[name.toLowerCase()] = String(value);
  }
  const names = Object.keys(signed).sort();

  const canonicalRequest = [
    method,
    url.pathname,
    '',
    `${names.map((name) => `${name}:${signed[name].trim()}`).join('\n')}\n`,
    names.join(';'),
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hashHex(canonicalRequest)].join('\n');
  let signingKey = sign(`AWS4${cfg.secretAccessKey}`, dateStamp);
  for (const part of [cfg.region, 's3', 'aws4_request']) signingKey = sign(signingKey, part);
  const signature = Buffer.from(sign(signingKey, stringToSign)).toString('hex');

  const { host, ...sendable } = signed;
  return fetch(url, {
    method,
    headers: {
      ...sendable,
      authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, `
        + `SignedHeaders=${names.join(';')}, Signature=${signature}`,
    },
    body,
  });
}

/** Bucket errors arrive as an XML body; surface the code, never the credential. */
async function storageError(verb, key, response) {
  const body = await response.text().catch(() => '');
  const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1];
  return new Error(
    `Could not ${verb} object ${key}: ${response.status}${code ? ` ${code}` : ''}`,
  );
}

const asNumber = (value) => (value === null || value === '' ? undefined : Number(value));

export const s3Driver = {
  name: 's3',

  async put(key, buffer, { contentType } = {}) {
    const payload = config.storage.encryptAtRest ? encryptBuffer(buffer) : buffer;
    const response = await request('PUT', key, {
      body: payload,
      headers: {
        'content-type': contentType || 'application/octet-stream',
        // The plaintext length and checksum, so `head` can report the size the
        // caller stored rather than the size of the sealed blob.
        'x-amz-meta-bytes': String(buffer.length),
        'x-amz-meta-encrypted': String(Boolean(config.storage.encryptAtRest)),
        'x-amz-meta-checksum': sha256(buffer),
      },
    });
    if (!response.ok) throw await storageError('store', key, response);
    return { key, bytes: buffer.length, encrypted: config.storage.encryptAtRest };
  },

  async get(key) {
    const response = await request('GET', key);
    if (!response.ok) throw await storageError('read', key, response);
    return decryptBuffer(Buffer.from(await response.arrayBuffer()));
  },

  async head(key) {
    const response = await request('HEAD', key);
    if (!response.ok) return null;
    const lastModified = response.headers.get('last-modified');
    return {
      key,
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      bytes: asNumber(response.headers.get('x-amz-meta-bytes'))
        ?? asNumber(response.headers.get('content-length')),
      storedBytes: asNumber(response.headers.get('content-length')),
      encrypted: response.headers.get('x-amz-meta-encrypted') === 'true',
      checksum: response.headers.get('x-amz-meta-checksum') || undefined,
      createdAt: lastModified ? new Date(lastModified).toISOString() : undefined,
    };
  },

  async delete(key) {
    const response = await request('DELETE', key);
    // A delete of something already gone is a success, as it is on the filesystem.
    if (response.ok || response.status === 404) return true;
    throw await storageError('delete', key, response);
  },

  async exists(key) {
    return (await request('HEAD', key)).ok;
  },
};

export default s3Driver;
