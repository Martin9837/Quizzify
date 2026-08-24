import { Router } from 'express';
import { all, get, insert, run } from '../db/index.js';
import { id } from '../lib/ids.js';
import { nowIso, addSeconds } from '../lib/time.js';
import { hashPassword, verifyPassword, signJwt, randomToken, sha256, safeEqual } from '../lib/crypto.js';
import { validate, EMAIL_PATTERN } from '../lib/validate.js';
import { unauthorized, badRequest, notFound } from '../lib/errors.js';
import { permissionsFor, ROLE_LABELS } from '../lib/permissions.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { authenticate } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import config from '../config.js';
import * as audit from '../services/audit.js';
import { orgSettings, organization } from '../services/org.js';
import logger from '../lib/logger.js';

const router = Router();

const authLimiter = rateLimit({ max: config.rateLimit.authMax, scope: 'auth' });

function issueTokens({ user, req }) {
  const accessToken = signJwt(
    { sub: user.id, org: user.organization_id, role: user.role, email: user.email, type: 'access' },
    { expiresInSeconds: config.auth.accessTtlSeconds },
  );
  const refreshToken = randomToken(48);
  insert('sessions', {
    id: id('ses'),
    user_id: user.id,
    organization_id: user.organization_id,
    refresh_token_hash: sha256(refreshToken),
    user_agent: req.get('user-agent') || null,
    ip: req.ip,
    expires_at: addSeconds(config.auth.refreshTtlSeconds),
    created_at: nowIso(),
  });
  return { accessToken, refreshToken, expiresIn: config.auth.accessTtlSeconds };
}

export function userView(user) {
  return {
    id: user.id,
    organizationId: user.organization_id,
    email: user.email,
    name: user.name,
    role: user.role,
    roleLabel: ROLE_LABELS[user.role] || user.role,
    teamId: user.team_id,
    title: user.title,
    phone: user.phone,
    avatarColor: user.avatar_color,
    timezone: user.timezone,
    quota: user.quota_amount,
    status: user.status,
    permissions: permissionsFor(user.role),
    lastLoginAt: user.last_login_at,
  };
}

// POST /auth/login
router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    email: { type: 'string', required: true, pattern: EMAIL_PATTERN, message: 'must be a valid email address' },
    password: { type: 'string', required: true, maxLength: 200 },
    organizationSlug: { type: 'string' },
  });

  const email = body.email.toLowerCase();
  // Scope the lookup by organisation when a slug is supplied so the same email
  // can exist in more than one tenant.
  const candidates = body.organizationSlug
    ? all(
      `SELECT u.* FROM users u JOIN organizations o ON o.id = u.organization_id
       WHERE LOWER(u.email) = ? AND o.slug = ?`,
      [email, body.organizationSlug],
    )
    : all('SELECT * FROM users WHERE LOWER(email) = ?', [email]);

  const user = candidates.find((candidate) => verifyPassword(body.password, candidate.password_hash));
  if (!user) {
    logger.warn('failed login', { email, ip: req.ip });
    // Deliberately identical message for unknown user and wrong password.
    throw unauthorized('Email or password is incorrect');
  }
  if (user.status === 'suspended') throw unauthorized('This account has been suspended');

  run('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), user.id]);
  const tokens = issueTokens({ user, req });

  audit.record({
    organizationId: user.organization_id,
    actorId: user.id,
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    source: 'ui',
    ip: req.ip,
    userAgent: req.get('user-agent'),
    requestId: req.id,
  });

  res.json({
    ...tokens,
    user: userView(user),
    organization: {
      ...pickOrg(organization(user.organization_id)),
      settings: orgSettings(user.organization_id),
    },
  });
}));

function pickOrg(org) {
  return {
    id: org.id, name: org.name, slug: org.slug, plan: org.plan, seats: org.seats,
    currency: org.currency, timezone: org.timezone,
  };
}

// POST /auth/refresh
router.post('/refresh', authLimiter, asyncHandler(async (req, res) => {
  const body = validate(req.body, { refreshToken: { type: 'string', required: true, maxLength: 200 } });
  const hash = sha256(body.refreshToken);
  const session = get(
    'SELECT * FROM sessions WHERE refresh_token_hash = ? AND revoked_at IS NULL AND expires_at > ?',
    [hash, nowIso()],
  );
  if (!session || !safeEqual(session.refresh_token_hash, hash)) throw unauthorized('Refresh token is invalid or expired');

  const user = get('SELECT * FROM users WHERE id = ?', [session.user_id]);
  if (!user || user.status !== 'active') throw unauthorized('Account is not active');

  // Rotate: the presented token is revoked and a new one issued, so a stolen
  // refresh token is usable at most once.
  run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [nowIso(), session.id]);
  const tokens = issueTokens({ user, req });
  res.json({ ...tokens, user: userView(user) });
}));

// POST /auth/logout
router.post('/logout', authenticate, asyncHandler(async (req, res) => {
  const body = validate(req.body || {}, { refreshToken: { type: 'string' }, allDevices: { type: 'boolean', default: false } }, { partial: true });
  if (body.allDevices) {
    run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), req.auth.userId]);
  } else if (body.refreshToken) {
    run('UPDATE sessions SET revoked_at = ? WHERE refresh_token_hash = ?', [nowIso(), sha256(body.refreshToken)]);
  }
  audit.recordFromRequest(req, { action: 'auth.logout', entityType: 'user', entityId: req.auth.userId });
  res.json({ ok: true });
}));

// GET /auth/me
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const user = get('SELECT * FROM users WHERE id = ?', [req.auth.userId]);
  if (!user) throw notFound('User');
  const team = user.team_id ? get('SELECT id, name, region FROM teams WHERE id = ?', [user.team_id]) : null;
  res.json({
    user: userView(user),
    team,
    organization: { ...pickOrg(organization(user.organization_id)), settings: orgSettings(user.organization_id) },
    sessions: all(
      `SELECT id, user_agent, ip, created_at, expires_at FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 10`,
      [user.id, nowIso()],
    ),
  });
}));

// PATCH /auth/me
router.patch('/me', authenticate, asyncHandler(async (req, res) => {
  const patch = validate(req.body, {
    name: { type: 'string', maxLength: 120 },
    phone: { type: 'string', maxLength: 40 },
    title: { type: 'string', maxLength: 120 },
    timezone: { type: 'string', maxLength: 60 },
    avatarColor: { type: 'string', maxLength: 20 },
    preferences: { type: 'object' },
  }, { partial: true });

  const before = get('SELECT * FROM users WHERE id = ?', [req.auth.userId]);
  const columns = {
    name: patch.name,
    phone: patch.phone,
    title: patch.title,
    timezone: patch.timezone,
    avatar_color: patch.avatarColor,
    preferences: patch.preferences ? JSON.stringify({ ...JSON.parse(before.preferences || '{}'), ...patch.preferences }) : undefined,
  };
  const keys = Object.keys(columns).filter((k) => columns[k] !== undefined);
  if (keys.length) {
    run(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => columns[k]), nowIso(), req.auth.userId]);
  }
  const after = get('SELECT * FROM users WHERE id = ?', [req.auth.userId]);
  audit.recordFromRequest(req, { action: 'user.update_self', entityType: 'user', entityId: req.auth.userId, before, after });
  res.json({ user: userView(after) });
}));

// POST /auth/change-password
router.post('/change-password', authenticate, authLimiter, asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    currentPassword: { type: 'string', required: true, maxLength: 200 },
    newPassword: { type: 'string', required: true, maxLength: 200 },
  });
  const settings = orgSettings(req.auth.organizationId);
  const minLength = settings.security?.passwordMinLength || 10;
  if (body.newPassword.length < minLength) throw badRequest(`Password must be at least ${minLength} characters`);
  if (!/[A-Za-z]/.test(body.newPassword) || !/\d/.test(body.newPassword)) {
    throw badRequest('Password must contain both letters and numbers');
  }

  const user = get('SELECT * FROM users WHERE id = ?', [req.auth.userId]);
  if (!verifyPassword(body.currentPassword, user.password_hash)) throw unauthorized('Current password is incorrect');

  run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(body.newPassword), nowIso(), user.id]);
  // Changing a password invalidates every other session.
  run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), user.id]);
  audit.recordFromRequest(req, { action: 'auth.password_change', entityType: 'user', entityId: user.id });
  res.json({ ok: true, message: 'Password updated. Other sessions have been signed out.' });
}));

// DELETE /auth/sessions/:id
router.delete('/sessions/:sessionId', authenticate, asyncHandler(async (req, res) => {
  const session = get('SELECT * FROM sessions WHERE id = ? AND user_id = ?', [req.params.sessionId, req.auth.userId]);
  if (!session) throw notFound('Session');
  run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [nowIso(), session.id]);
  res.json({ ok: true });
}));

export default router;
