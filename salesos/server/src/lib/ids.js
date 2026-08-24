import { randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short, URL-safe id with a type prefix (e.g. `lead_k3f9...`). */
export function id(prefix) {
  const bytes = randomBytes(12);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}

export const uuid = () => randomUUID();

/** Request id used to correlate logs and audit entries. */
export const requestId = () => `req_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
