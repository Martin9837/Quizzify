import config from '../../config.js';
import { encryptBuffer, decryptBuffer, sha256 } from '../../lib/crypto.js';

/**
 * Call recordings stored through a Cloudflare R2 *binding*.
 *
 * The s3 driver beside this one talks to R2 perfectly well over its HTTP API,
 * but only if somebody creates an access key pair and puts it in the
 * deployment's secrets. A Worker with an R2 binding needs none of that: the
 * bucket arrives on `env`, already authorised, and the request never leaves
 * Cloudflare's network. Without it the deployed Worker has no durable object
 * store at all -- `local` writes to a filesystem that is memory-backed on
 * workerd and gone at the end of the request, so every recording, and with it
 * every transcript, analysis and coaching score, was lost the moment it was
 * written.
 *
 * Same contract as the other two drivers, including encrypting before the
 * bytes leave the process and reporting the plaintext size from `head`.
 */

let bucket = null;

/** Called by the Worker entrypoint with `env.RECORDINGS`. */
export function setBucket(next) {
  bucket = next || null;
  return bucket;
}

export function hasBucket() {
  return Boolean(bucket);
}

function requireBucket() {
  if (!bucket) {
    throw new Error('No R2 bucket is bound. Set STORAGE_DRIVER away from r2binding, or bind RECORDINGS in wrangler.toml.');
  }
  return bucket;
}

export const r2BindingDriver = {
  name: 'r2binding',

  async put(key, buffer, { contentType } = {}) {
    const payload = config.storage.encryptAtRest ? encryptBuffer(buffer) : buffer;
    // Custom metadata values are strings on R2, as they are on S3. The
    // plaintext length and checksum are kept so `head` can report the size the
    // caller stored rather than the size of the sealed blob.
    await requireBucket().put(key, payload, {
      httpMetadata: { contentType: contentType || 'application/octet-stream' },
      customMetadata: {
        bytes: String(buffer.length),
        encrypted: String(Boolean(config.storage.encryptAtRest)),
        checksum: sha256(buffer),
      },
    });
    return { key, bytes: buffer.length, encrypted: config.storage.encryptAtRest };
  },

  async get(key) {
    const object = await requireBucket().get(key);
    if (!object) throw new Error(`Could not read ${key}: no such object`);
    return decryptBuffer(Buffer.from(await object.arrayBuffer()));
  },

  async head(key) {
    const object = await requireBucket().head(key);
    if (!object) return null;
    const meta = object.customMetadata || {};
    return {
      key,
      contentType: object.httpMetadata?.contentType || 'application/octet-stream',
      bytes: meta.bytes === undefined ? object.size : Number(meta.bytes),
      storedBytes: object.size,
      encrypted: meta.encrypted === 'true',
      checksum: meta.checksum || undefined,
      createdAt: object.uploaded ? new Date(object.uploaded).toISOString() : undefined,
    };
  },

  async delete(key) {
    // Deleting something already gone is a success, as it is on the filesystem
    // and over S3.
    await requireBucket().delete(key);
    return true;
  },

  async exists(key) {
    return Boolean(await requireBucket().head(key));
  },
};

export default r2BindingDriver;
