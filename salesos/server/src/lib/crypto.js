import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import config from '../config.js';
import { unauthorized } from './errors.js';

// ------------------------------------------------------------- passwords ----
const { N, r, p, keylen } = config.auth.scrypt;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, n, rr, pp, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(rr),
      p: Number(pp),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ JWT -----
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(str, 'base64url');

export function signJwt(payload, { expiresInSeconds = config.auth.accessTtlSeconds } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + expiresInSeconds, ...payload };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify(body));
  const signature = createHmac('sha256', config.auth.jwtSecret).update(`${header}.${claims}`).digest('base64url');
  return `${header}.${claims}.${signature}`;
}

export function verifyJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw unauthorized('Malformed token');
  const [header, claims, signature] = parts;
  const expected = createHmac('sha256', config.auth.jwtSecret).update(`${header}.${claims}`).digest();
  const provided = fromB64url(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw unauthorized('Invalid token signature');
  }
  let payload;
  try {
    payload = JSON.parse(fromB64url(claims).toString('utf8'));
  } catch {
    throw unauthorized('Malformed token payload');
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw unauthorized('Token expired');
  return payload;
}

// ------------------------------------------------------------- hashing ------
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function hmac(value, key = config.encryption.key) {
  return createHmac('sha256', key).update(value).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

// --------------------------------------------------- envelope encryption ----
// AES-256-GCM. Output format: v1.<iv>.<tag>.<ciphertext> (all base64url).
function derivedKey() {
  return createHash('sha256').update(config.encryption.key).digest();
}

export function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function decrypt(payload) {
  if (!payload) return null;
  const [version, ivB64, tagB64, dataB64] = String(payload).split('.');
  if (version !== 'v1') throw new Error('Unsupported ciphertext version');
  const decipher = createDecipheriv('aes-256-gcm', derivedKey(), fromB64url(ivB64));
  decipher.setAuthTag(fromB64url(tagB64));
  return Buffer.concat([decipher.update(fromB64url(dataB64)), decipher.final()]).toString('utf8');
}

export function encryptBuffer(buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey(), iv);
  const enc = Buffer.concat([cipher.update(buffer), cipher.final()]);
  // [magic(4)][iv(12)][tag(16)][ciphertext]
  return Buffer.concat([Buffer.from('SOS1'), iv, cipher.getAuthTag(), enc]);
}

export function decryptBuffer(buffer) {
  if (buffer.subarray(0, 4).toString() !== 'SOS1') return buffer; // stored unencrypted
  const iv = buffer.subarray(4, 16);
  const tag = buffer.subarray(16, 32);
  const decipher = createDecipheriv('aes-256-gcm', derivedKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buffer.subarray(32)), decipher.final()]);
}
