import { all, get, run, inList, parseJson } from '../db/index.js';
import { verifyJwt, sha256 } from '../lib/crypto.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { can, atLeast, visibilityScope } from '../lib/permissions.js';
import { nowIso } from '../lib/time.js';
import { orgSettings } from '../services/org.js';

/**
 * Authentication and tenant isolation.
 *
 * `req.auth` is the only source of organisation identity in the whole
 * application. Nothing reads an organisation id from the request body or query
 * string, which is what makes cross-tenant access structurally impossible
 * rather than merely unlikely.
 */

function bearerToken(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  // Event-stream and media endpoints cannot set headers from the browser.
  if (req.query?.access_token) return String(req.query.access_token);
  return null;
}

export function authenticate(req, res, next) {
  try {
    const apiKey = req.get('x-api-key');
    if (apiKey) return authenticateApiKey(req, apiKey, next);

    const token = bearerToken(req);
    if (!token) throw unauthorized();
    const payload = verifyJwt(token);
    if (payload.type && payload.type !== 'access') throw unauthorized('Wrong token type');

    const user = get(
      'SELECT id, organization_id, email, name, role, team_id, status, phone, title, timezone FROM users WHERE id = ?',
      [payload.sub],
    );
    if (!user) throw unauthorized('User no longer exists');
    if (user.status !== 'active') throw forbidden('This account is not active');
    if (user.organization_id !== payload.org) throw unauthorized('Token does not match this account');

    // Both of these are settings the admin screen has always let an operator
    // set and nothing has ever read. An access token outliving the configured
    // session, and a request from outside the configured address range, were
    // both accepted -- so an operator who believed they had locked the product
    // to their office network had changed nothing at all.
    const security = orgSettings(user.organization_id).security || {};
    enforceSessionTimeout(payload, security);
    enforceIpAllowlist(req, security);

    req.auth = {
      userId: user.id,
      organizationId: user.organization_id,
      email: user.email,
      name: user.name,
      role: user.role,
      teamId: user.team_id,
      phone: user.phone,
      title: user.title,
      timezone: user.timezone,
      scope: visibilityScope({ id: user.id, role: user.role }),
      via: 'jwt',
    };
    req.user = { ...req.auth, id: user.id };
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Expire a token earlier than its own `exp` when the organisation asks for a
 * shorter session. The JWT lifetime is a deployment-wide default; this is the
 * tenant's own policy, and it applies without reissuing anyone's token.
 */
function enforceSessionTimeout(payload, security) {
  const minutes = Number(security.sessionTimeoutMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  const issuedAt = Number(payload.iat);
  if (!Number.isFinite(issuedAt)) return;
  const ageSeconds = Math.floor(Date.now() / 1000) - issuedAt;
  if (ageSeconds > minutes * 60) {
    throw unauthorized('This session has expired. Sign in again.');
  }
}

/**
 * Restrict access to the configured CIDR ranges. An empty list means no
 * restriction, which is the default and how the admin screen describes it.
 *
 * IPv4 only for now, and a range that cannot be parsed is ignored rather than
 * treated as a block: a typo in this field must not lock an organisation out
 * of its own account.
 */
function enforceIpAllowlist(req, security) {
  const ranges = Array.isArray(security.ipAllowlist) ? security.ipAllowlist.filter(Boolean) : [];
  if (!ranges.length) return;
  const address = clientIp(req);
  if (!address) return;
  if (!ranges.some((range) => ipInRange(address, range))) {
    throw forbidden('Your network is not permitted to reach this organisation');
  }
}

function clientIp(req) {
  // Behind Cloudflare the socket address is the edge, not the caller.
  const forwarded = req.get('cf-connecting-ip') || (req.get('x-forwarded-for') || '').split(',')[0].trim();
  const raw = forwarded || req.ip || '';
  // Express reports IPv4 over IPv6 as ::ffff:a.b.c.d.
  return raw.replace(/^::ffff:/, '');
}

function ipToLong(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  let total = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    total = total * 256 + octet;
  }
  return total;
}

function ipInRange(address, range) {
  const [base, bitsRaw] = String(range).split('/');
  const target = ipToLong(address);
  const start = ipToLong(base);
  if (target === null || start === null) return false;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((target & mask) >>> 0) === ((start & mask) >>> 0);
}

function authenticateApiKey(req, apiKey, next) {
  const prefix = apiKey.slice(0, 8);
  const record = get('SELECT * FROM api_keys WHERE prefix = ? AND revoked_at IS NULL', [prefix]);
  if (!record || record.key_hash !== sha256(apiKey)) return next(unauthorized('Invalid API key'));
  run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [nowIso(), record.id]);

  req.auth = {
    userId: record.created_by,
    organizationId: record.organization_id,
    email: `apikey:${record.name}`,
    name: `API key: ${record.name}`,
    // API keys act with admin authority within their organisation but are
    // recorded distinctly in the audit trail.
    role: 'admin',
    teamId: null,
    scope: 'org',
    via: 'api_key',
    apiKeyId: record.id,
    // The scopes the key was created with. They were collected, stored and
    // displayed, and then never read: a key scoped to lead:read could create
    // administrators. '*' keeps the existing all-access behaviour, which is
    // what every key gets by default.
    scopes: parseJson(record.scopes, ['*']),
  };
  req.user = { ...req.auth, id: record.created_by };
  return next();
}

/** Optional auth: used by endpoints that behave differently when signed in. */
export function authenticateOptional(req, res, next) {
  if (!bearerToken(req) && !req.get('x-api-key')) return next();
  return authenticate(req, res, next);
}

export function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.auth) return next(unauthorized());
    const missing = permissions.filter((permission) => !can(req.auth.role, permission));
    if (missing.length) {
      return next(forbidden(`Your role (${req.auth.role}) cannot ${missing.join(', ')}`));
    }
    // A key may never do more than its scopes allow, whatever role it acts
    // with. Checked after the role so the message names the narrower reason.
    const unscoped = permissions.filter((permission) => !withinScopes(req.auth, permission));
    if (unscoped.length) {
      return next(forbidden(`This API key is not scoped for ${unscoped.join(', ')}`));
    }
    return next();
  };
}

/** True unless the caller is an API key whose scopes exclude the permission. */
function withinScopes(auth, permission) {
  if (auth.via !== 'api_key') return true;
  const scopes = auth.scopes;
  if (!Array.isArray(scopes) || scopes.includes('*')) return true;
  if (scopes.includes(permission)) return true;
  // A scope may name a whole resource -- "lead" covers lead:read and
  // lead:write -- which is how people expect to write them.
  const [resource] = permission.split(':');
  return scopes.includes(resource) || scopes.includes(`${resource}:*`);
}

export function requireRole(minimumRole) {
  return (req, res, next) => {
    if (!req.auth) return next(unauthorized());
    if (!atLeast(req.auth.role, minimumRole)) {
      return next(forbidden(`This action requires the ${minimumRole.replace('_', ' ')} role or above`));
    }
    return next();
  };
}

/**
 * Resolve the set of user ids the caller may see records for.
 * Cached on the request because several handlers need it.
 */
export function visibleUserIds(req) {
  if (req._visibleUserIds) return req._visibleUserIds;
  const { scope, organizationId, userId, teamId } = req.auth;
  let ids;
  if (scope === 'org') {
    ids = 'all';
  } else if (scope === 'team') {
    ids = all(
      'SELECT id FROM users WHERE organization_id = ? AND (team_id = ? OR id = ?)',
      [organizationId, teamId || '', userId],
    ).map((u) => u.id);
  } else {
    ids = [userId];
  }
  req._visibleUserIds = ids;
  return ids;
}

/** SQL fragment restricting a query to the caller's visible records. */
export function ownerScopeClause(req, column = 'owner_id', { includeUnassigned = false } = {}) {
  const ids = visibleUserIds(req);
  if (ids === 'all') return { sql: '', params: [] };
  if (!ids.length) return { sql: ' AND 1 = 0', params: [] };
  // One bound parameter for the whole list; see inList().
  const { sql: inSql, params } = inList(column, ids);
  return {
    sql: includeUnassigned
      ? ` AND (${inSql} OR ${column} IS NULL)`
      : ` AND ${inSql}`,
    params,
  };
}

/** Throws unless the caller may act on a record owned by `ownerId`. */
export function assertRecordAccess(req, ownerId) {
  const ids = visibleUserIds(req);
  if (ids === 'all') return true;
  if (!ownerId) return true;
  if (!ids.includes(ownerId)) throw forbidden('This record belongs to another agent');
  return true;
}

export default {
  authenticate, authenticateOptional, requirePermission, requireRole,
  visibleUserIds, ownerScopeClause, assertRecordAccess,
};
