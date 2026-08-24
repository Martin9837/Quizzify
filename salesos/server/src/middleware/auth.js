import { all, get, run } from '../db/index.js';
import { verifyJwt, sha256 } from '../lib/crypto.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { can, atLeast, visibilityScope } from '../lib/permissions.js';
import { nowIso } from '../lib/time.js';

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
    return next();
  };
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
  const placeholders = ids.map(() => '?').join(', ');
  return {
    sql: includeUnassigned
      ? ` AND (${column} IN (${placeholders}) OR ${column} IS NULL)`
      : ` AND ${column} IN (${placeholders})`,
    params: ids,
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
