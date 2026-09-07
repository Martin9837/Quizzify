import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import config from '../../config.js';
import logger from '../../lib/logger.js';
import { encryptBuffer, decryptBuffer, sha256 } from '../../lib/crypto.js';
import { s3Driver } from './provider.s3.js';

/**
 * Object storage abstraction for call recordings and voicemail.
 *
 * The local driver is a filesystem-backed implementation used in development
 * and single-node deployments; it writes AES-256-GCM encrypted blobs when
 * `STORAGE_ENCRYPT_AT_REST` is on. `s3` (and its alias `r2`) is the same
 * contract over a signed HTTP API, for any host without a persistent disk.
 */

const drivers = {};

drivers.local = {
  name: 'local',
  async put(key, buffer, { contentType } = {}) {
    const full = path.join(config.storage.root, key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const payload = config.storage.encryptAtRest ? encryptBuffer(buffer) : buffer;
    await fsp.writeFile(full, payload);
    await fsp.writeFile(`${full}.meta.json`, JSON.stringify({
      key,
      contentType: contentType || 'application/octet-stream',
      bytes: buffer.length,
      storedBytes: payload.length,
      encrypted: config.storage.encryptAtRest,
      checksum: sha256(buffer),
      createdAt: new Date().toISOString(),
    }, null, 2));
    return { key, bytes: buffer.length, encrypted: config.storage.encryptAtRest };
  },
  async get(key) {
    const full = path.join(config.storage.root, key);
    const raw = await fsp.readFile(full);
    return decryptBuffer(raw);
  },
  async head(key) {
    const full = path.join(config.storage.root, key);
    try {
      return JSON.parse(await fsp.readFile(`${full}.meta.json`, 'utf8'));
    } catch {
      const stat = await fsp.stat(full).catch(() => null);
      return stat ? { key, bytes: stat.size } : null;
    }
  },
  async delete(key) {
    const full = path.join(config.storage.root, key);
    await fsp.rm(full, { force: true });
    await fsp.rm(`${full}.meta.json`, { force: true });
    return true;
  },
  async exists(key) {
    return fs.existsSync(path.join(config.storage.root, key));
  },
};

// One SigV4 implementation serves every S3-compatible store. `r2` is the same
// driver under the name people reach for, so a Cloudflare deployment reads as
// STORAGE_DRIVER=r2 rather than as S3 pointed somewhere unexpected.
drivers.s3 = s3Driver;
drivers.r2 = s3Driver;

function driver() {
  return drivers[config.storage.driver] || drivers.local;
}

export function recordingKey(organizationId, callId) {
  const day = new Date().toISOString().slice(0, 10);
  return `${organizationId}/recordings/${day}/${callId}.audio`;
}

export function voicemailKey(organizationId, callId) {
  const day = new Date().toISOString().slice(0, 10);
  return `${organizationId}/voicemail/${day}/${callId}.audio`;
}

export async function putObject(key, buffer, options) {
  const result = await driver().put(key, buffer, options);
  logger.debug('object stored', { key, bytes: result.bytes, driver: driver().name });
  return result;
}

export const getObject = (key) => driver().get(key);
export const headObject = (key) => driver().head(key);
export const objectExists = (key) => driver().exists(key);

export async function deleteObject(key) {
  const ok = await driver().delete(key);
  logger.info('object deleted', { key, driver: driver().name });
  return ok;
}

/** Short-lived signed URL for streaming a recording through the API. */
export function signedUrl(key, token) {
  return `/api/v1/recordings/stream?key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
}

export default { putObject, getObject, headObject, deleteObject, objectExists, recordingKey, voicemailKey, signedUrl };
