import { get, run, parseJson } from '../db/index.js';
import { DEFAULT_ORG_SETTINGS } from '../lib/constants.js';
import { nowIso } from '../lib/time.js';
import { notFound, unprocessable } from '../lib/errors.js';

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

/**
 * Settings that change behaviour, checked before they are stored.
 *
 * updateSettings deep-merges whatever it is given, so an unvalidated patch used
 * to persist anything: mode "banana", a threshold of "high", autoCreateTasks
 * "yes". None of it errored, and each one quietly changed what the product does
 * while the admin screen reported the value back as though it had taken effect:
 *
 *  - an unrecognised mode is not 'auto', so automation silently behaves as
 *    suggest while the org believes it is configured otherwise;
 *  - a non-numeric threshold makes every `confidence >= threshold` comparison
 *    NaN, so auto-apply never fires even in auto mode;
 *  - a NEGATIVE threshold is the dangerous one -- every suggestion clears it, so
 *    a typo turns the confidence floor off entirely and the AI writes to the CRM
 *    unreviewed.
 *
 * Only the fields whose values carry meaning are constrained; everything else
 * merges as before, so this does not become a schema for the whole settings
 * blob.
 */
const SETTING_RULES = [
  ['crmApproval.mode', (v) => ['suggest', 'auto'].includes(v), "must be 'suggest' or 'auto'"],
  ['crmApproval.autoApplyConfidenceThreshold',
    (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1,
    'must be a number between 0 and 1'],
  ['crmApproval.alwaysReviewSensitive', (v) => typeof v === 'boolean', 'must be true or false'],
  ['crmApproval.autoCreateTasks', (v) => typeof v === 'boolean', 'must be true or false'],
  ['recording.enabled', (v) => typeof v === 'boolean', 'must be true or false'],
  ['recording.consentMode', (v) => ['all_party', 'one_party', 'disabled'].includes(v),
    "must be 'all_party', 'one_party' or 'disabled'"],
  ['transcription.enabled', (v) => typeof v === 'boolean', 'must be true or false'],
  ['transcription.minimumCallSeconds',
    (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3600,
    'must be a whole number of seconds between 0 and 3600'],
];

function assertValidSettings(patch) {
  const problems = [];
  for (const [path, isValid, expectation] of SETTING_RULES) {
    const [block, key] = path.split('.');
    const supplied = patch?.[block];
    if (!supplied || typeof supplied !== 'object' || !(key in supplied)) continue;
    if (!isValid(supplied[key])) {
      problems.push({ field: path, message: expectation, received: supplied[key] });
    }
  }
  if (problems.length) throw unprocessable('Some settings were not valid', problems);
}

export function updateSettings(organizationId, patch) {
  assertValidSettings(patch);
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
