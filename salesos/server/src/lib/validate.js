import { badRequest, unprocessable } from './errors.js';

/**
 * Tiny declarative validator. Each rule is
 *   { type, required, default, enum, min, max, maxLength, pattern, of, coerce }
 * Unknown keys are dropped: routes get exactly the shape they declare.
 */
export function validate(input, schema, { partial = false, path = '' } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  const errors = [];

  for (const [key, rule] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(source, key);
    let value = source[key];

    if (!present || value === undefined) {
      if (partial) continue;
      if (rule.required) {
        errors.push({ field: path + key, message: 'is required' });
        continue;
      }
      if (rule.default !== undefined) out[key] = typeof rule.default === 'function' ? rule.default() : rule.default;
      continue;
    }

    if (value === null) {
      if (rule.required) errors.push({ field: path + key, message: 'cannot be null' });
      else out[key] = null;
      continue;
    }

    switch (rule.type) {
      case 'string': {
        value = String(value);
        if (rule.trim !== false) value = value.trim();
        if (value === '' && rule.required) {
          errors.push({ field: path + key, message: 'cannot be empty' });
          continue;
        }
        if (rule.maxLength && value.length > rule.maxLength) {
          errors.push({ field: path + key, message: `must be at most ${rule.maxLength} characters` });
          continue;
        }
        if (rule.pattern && value && !rule.pattern.test(value)) {
          errors.push({ field: path + key, message: rule.message || 'has an invalid format' });
          continue;
        }
        break;
      }
      case 'number': {
        const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
        if (Number.isNaN(n)) {
          errors.push({ field: path + key, message: 'must be a number' });
          continue;
        }
        if (rule.min !== undefined && n < rule.min) {
          errors.push({ field: path + key, message: `must be >= ${rule.min}` });
          continue;
        }
        if (rule.max !== undefined && n > rule.max) {
          errors.push({ field: path + key, message: `must be <= ${rule.max}` });
          continue;
        }
        value = rule.integer ? Math.round(n) : n;
        break;
      }
      case 'boolean': {
        value = value === true || value === 1 || value === '1' || value === 'true';
        break;
      }
      case 'date': {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) {
          errors.push({ field: path + key, message: 'must be a valid date' });
          continue;
        }
        value = d.toISOString();
        break;
      }
      case 'array': {
        if (!Array.isArray(value)) {
          if (typeof value === 'string') value = value.split(',').map((s) => s.trim()).filter(Boolean);
          else {
            errors.push({ field: path + key, message: 'must be an array' });
            continue;
          }
        }
        if (rule.of === 'string') value = value.map((v) => String(v).trim()).filter(Boolean);
        if (rule.maxItems && value.length > rule.maxItems) value = value.slice(0, rule.maxItems);
        break;
      }
      case 'object': {
        if (typeof value !== 'object' || Array.isArray(value)) {
          errors.push({ field: path + key, message: 'must be an object' });
          continue;
        }
        break;
      }
      default:
        break;
    }

    if (rule.enum && !rule.enum.includes(value)) {
      errors.push({ field: path + key, message: `must be one of: ${rule.enum.join(', ')}` });
      continue;
    }

    out[key] = rule.coerce ? rule.coerce(value) : value;
  }

  if (errors.length) throw unprocessable('Validation failed', errors);
  return out;
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function parsePagination(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit));
  const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
  return { limit, offset };
}

/**
 * A query parameter that ends up in arithmetic, a Date, or a SQL bound.
 *
 * `Number('1e400')` is `Infinity`, and neither Date nor SQLite can represent
 * it: `new Date(x).toISOString()` throws "Invalid time value" and an Infinity
 * bound in `LIMIT ?` fails as SQLITE_MISMATCH. Both reached users as a 500
 * from an ordinary query string -- `?limit=1e400`, `?days=1e400`,
 * `?duration=1e400` -- so every such parameter goes through here.
 *
 * parseInt rather than Number on purpose: it stops at the first character that
 * cannot continue an integer, so exponent and hex notation degrade to a plain
 * number instead of becoming one bound away.
 */
export function boundedInt(value, fallback, { min = 1, max = 1000 } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * A numeric filter bound, where clamping would be a lie: `minValue=1e400`
 * means "nothing qualifies", not "everything above the cap". Non-finite and
 * unparseable input drops the filter instead of binding NaN, which silently
 * matches no rows.
 */
export function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Whitelist-based sort clause builder. Prevents SQL injection via `sort`. */
export function parseSort(query, allowed, fallback) {
  const raw = String(query.sort || '').trim();
  if (!raw) return fallback;
  const desc = raw.startsWith('-');
  const field = desc ? raw.slice(1) : raw;
  if (!allowed.includes(field)) throw badRequest(`Cannot sort by "${field}"`);
  return `${field} ${desc ? 'DESC' : 'ASC'}`;
}
