import { get, run, parseJson } from '../db/index.js';
import { DEFAULT_ORG_SETTINGS } from '../lib/constants.js';
import { nowIso } from '../lib/time.js';
import { notFound } from '../lib/errors.js';

/** Recursive merge so a tenant can override one nested key without losing siblings. */
export function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object'
      ? deepMerge(base[key], value)
      : value;
  }
  return out;
}

const cache = new Map();

export function orgSettings(organizationId) {
  if (cache.has(organizationId)) return cache.get(organizationId);
  const org = get('SELECT settings FROM organizations WHERE id = ?', [organizationId]);
  const merged = deepMerge(DEFAULT_ORG_SETTINGS, parseJson(org?.settings, {}));
  cache.set(organizationId, merged);
  return merged;
}

export function organization(organizationId) {
  const org = get('SELECT * FROM organizations WHERE id = ?', [organizationId]);
  if (!org) throw notFound('Organization');
  return { ...org, settings: deepMerge(DEFAULT_ORG_SETTINGS, parseJson(org.settings, {})) };
}

export function updateSettings(organizationId, patch) {
  const org = get('SELECT settings FROM organizations WHERE id = ?', [organizationId]);
  if (!org) throw notFound('Organization');
  const current = parseJson(org.settings, {});
  const next = deepMerge(current, patch);
  run('UPDATE organizations SET settings = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(next), nowIso(), organizationId]);
  cache.delete(organizationId);
  return orgSettings(organizationId);
}

export function invalidate(organizationId) {
  if (organizationId) cache.delete(organizationId);
  else cache.clear();
}

export default { orgSettings, organization, updateSettings, invalidate, deepMerge };
