import { Router } from 'express';
import { all, get, insert, run, parseJson } from '../db/index.js';
import { id } from '../lib/ids.js';
import { nowIso, startOfDay } from '../lib/time.js';
import { validate, parsePagination, EMAIL_PATTERN } from '../lib/validate.js';
import { hashPassword, randomToken, sha256, encrypt, decrypt } from '../lib/crypto.js';
import { ROLES, ROLE_LABELS, PERMISSIONS, permissionsFor } from '../lib/permissions.js';
import { WEBHOOK_EVENTS, DEFAULT_ORG_SETTINGS } from '../lib/constants.js';
import { notFound, badRequest, conflict, forbidden } from '../lib/errors.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requirePermission, requireRole } from '../middleware/auth.js';
import * as audit from '../services/audit.js';
import * as orgService from '../services/org.js';
import * as queue from '../services/queue/index.js';
import { reindexOrganization } from '../services/search/index.js';
import { userView } from './auth.js';
import * as ai from '../services/ai/index.js';
import { connectionCount } from '../services/realtime/index.js';

const router = Router();

// ------------------------------------------------------------------- users ---
router.get('/users', requirePermission('user:read'), asyncHandler(async (req, res) => {
  const rows = all(
    `SELECT u.*, t.name AS team_name,
       (SELECT COUNT(*) FROM leads l WHERE l.owner_id = u.id AND l.archived_at IS NULL) AS lead_count,
       (SELECT COUNT(*) FROM deals d WHERE d.owner_id = u.id AND d.stage NOT IN ('won','lost')) AS open_deals
     FROM users u LEFT JOIN teams t ON t.id = u.team_id
     WHERE u.organization_id = ? ORDER BY u.name ASC`,
    [req.auth.organizationId],
  );
  res.json({
    users: rows.map((row) => ({ ...userView(row), teamName: row.team_name, leadCount: row.lead_count, openDeals: row.open_deals })),
    roles: ROLES.map((role) => ({ key: role, label: ROLE_LABELS[role], permissions: permissionsFor(role) })),
  });
}));

router.post('/users', requirePermission('user:write'), asyncHandler(async (req, res) => {
  const data = validate(req.body, {
    email: { type: 'string', required: true, pattern: EMAIL_PATTERN, message: 'must be a valid email address', maxLength: 200 },
    name: { type: 'string', required: true, maxLength: 120 },
    role: { type: 'string', required: true, enum: ROLES },
    password: { type: 'string', maxLength: 200 },
    teamId: { type: 'string', maxLength: 40 },
    title: { type: 'string', maxLength: 120 },
    phone: { type: 'string', maxLength: 40 },
    quota: { type: 'number', min: 0 },
    timezone: { type: 'string', maxLength: 60 },
  });

  // Only a super admin may mint another super admin.
  if (data.role === 'super_admin' && req.auth.role !== 'super_admin') {
    throw forbidden('Only a super admin can create another super admin');
  }
  const existing = get('SELECT id FROM users WHERE organization_id = ? AND LOWER(email) = ?',
    [req.auth.organizationId, data.email.toLowerCase()]);
  if (existing) throw conflict('A user with that email already exists in this organisation');

  const seats = get('SELECT seats FROM organizations WHERE id = ?', [req.auth.organizationId])?.seats || 0;
  const used = get(`SELECT COUNT(*) AS n FROM users WHERE organization_id = ? AND status != 'suspended'`, [req.auth.organizationId])?.n || 0;
  if (seats && used >= seats) throw conflict(`All ${seats} seats are in use. Increase the plan seat count to add more users.`);

  const temporaryPassword = data.password || randomToken(9);
  const row = {
    id: id('user'),
    organization_id: req.auth.organizationId,
    email: data.email.toLowerCase(),
    name: data.name,
    password_hash: hashPassword(temporaryPassword),
    role: data.role,
    team_id: data.teamId || null,
    title: data.title || null,
    phone: data.phone || null,
    avatar_color: ['#2f6df6', '#e2694a', '#3f9f7f', '#8b5cf6', '#d4a017'][Math.floor(Math.random() * 5)],
    timezone: data.timezone || 'UTC',
    quota_amount: data.quota || 0,
    status: data.password ? 'active' : 'invited',
    preferences: '{}',
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('users', row);
  audit.recordFromRequest(req, { action: 'user.create', entityType: 'user', entityId: row.id, after: row });
  res.status(201).json({
    user: userView(row),
    // Returned once, never stored in plaintext.
    temporaryPassword: data.password ? undefined : temporaryPassword,
  });
}));

router.patch('/users/:userId', requirePermission('user:write'), asyncHandler(async (req, res) => {
  const before = get('SELECT * FROM users WHERE id = ? AND organization_id = ?', [req.params.userId, req.auth.organizationId]);
  if (!before) throw notFound('User');
  const patch = validate(req.body, {
    name: { type: 'string', maxLength: 120 },
    role: { type: 'string', enum: ROLES },
    teamId: { type: 'string', maxLength: 40 },
    title: { type: 'string', maxLength: 120 },
    phone: { type: 'string', maxLength: 40 },
    quota: { type: 'number', min: 0 },
    status: { type: 'string', enum: ['active', 'invited', 'suspended'] },
    timezone: { type: 'string', maxLength: 60 },
    resetPassword: { type: 'boolean' },
  }, { partial: true });

  if (patch.role === 'super_admin' && req.auth.role !== 'super_admin') {
    throw forbidden('Only a super admin can grant the super admin role');
  }
  if (before.role === 'super_admin' && req.auth.role !== 'super_admin') {
    throw forbidden('Only a super admin can modify another super admin');
  }
  // Never allow the last active administrator to lose access. This used to
  // enumerate the two changes it feared -- role 'agent' and status
  // 'suspended' -- and so let through role 'manager' and status 'invited',
  // either of which empties the organisation of administrators for good:
  // user:write is itself an admin permission, so nobody is left who can
  // promote anyone back. Ask what the row would become instead.
  const wasAdministrator = ['admin', 'super_admin'].includes(before.role) && before.status === 'active';
  const staysAdministrator = ['admin', 'super_admin'].includes(patch.role ?? before.role)
    && (patch.status ?? before.status) === 'active';
  if (wasAdministrator && !staysAdministrator) {
    const admins = get(
      `SELECT COUNT(*) AS n FROM users WHERE organization_id = ? AND role IN ('admin','super_admin')
         AND status = 'active' AND id != ?`,
      [req.auth.organizationId, before.id],
    )?.n || 0;
    if (!admins) {
      throw badRequest('This is the last active administrator. Promote another user first.');
    }
  }

  let temporaryPassword;
  const columns = {
    name: patch.name,
    role: patch.role,
    team_id: patch.teamId,
    title: patch.title,
    phone: patch.phone,
    quota_amount: patch.quota,
    status: patch.status,
    timezone: patch.timezone,
  };
  if (patch.resetPassword) {
    temporaryPassword = randomToken(9);
    columns.password_hash = hashPassword(temporaryPassword);
    run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), before.id]);
  }
  const keys = Object.keys(columns).filter((k) => columns[k] !== undefined);
  if (keys.length) {
    run(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => columns[k]), nowIso(), before.id]);
  }
  const after = get('SELECT * FROM users WHERE id = ?', [before.id]);
  audit.recordFromRequest(req, { action: 'user.update', entityType: 'user', entityId: after.id, before, after });
  res.json({ user: userView(after), temporaryPassword });
}));

// ------------------------------------------------------------------- teams ---
router.get('/teams', requirePermission('user:read'), asyncHandler(async (req, res) => {
  res.json({
    teams: all(
      `SELECT t.*, u.name AS manager_name, (SELECT COUNT(*) FROM users m WHERE m.team_id = t.id) AS member_count
       FROM teams t LEFT JOIN users u ON u.id = t.manager_id WHERE t.organization_id = ? ORDER BY t.name`,
      [req.auth.organizationId],
    ),
  });
}));

router.post('/teams', requirePermission('team:write'), asyncHandler(async (req, res) => {
  const data = validate(req.body, {
    name: { type: 'string', required: true, maxLength: 120 },
    region: { type: 'string', maxLength: 80 },
    managerId: { type: 'string', maxLength: 40 },
  });
  const row = {
    id: id('team'),
    organization_id: req.auth.organizationId,
    name: data.name,
    region: data.region || null,
    manager_id: data.managerId || null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('teams', row);
  audit.recordFromRequest(req, { action: 'team.create', entityType: 'team', entityId: row.id, after: row });
  res.status(201).json({ team: row });
}));

router.patch('/teams/:teamId', requirePermission('team:write'), asyncHandler(async (req, res) => {
  const before = get('SELECT * FROM teams WHERE id = ? AND organization_id = ?', [req.params.teamId, req.auth.organizationId]);
  if (!before) throw notFound('Team');
  const patch = validate(req.body, {
    name: { type: 'string', maxLength: 120 },
    region: { type: 'string', maxLength: 80 },
    managerId: { type: 'string', maxLength: 40 },
  }, { partial: true });
  const columns = { name: patch.name, region: patch.region, manager_id: patch.managerId };
  const keys = Object.keys(columns).filter((k) => columns[k] !== undefined);
  if (keys.length) {
    run(`UPDATE teams SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => columns[k]), nowIso(), before.id]);
  }
  res.json({ team: get('SELECT * FROM teams WHERE id = ?', [before.id]) });
}));

// ---------------------------------------------------------- custom fields ---
router.get('/custom-fields', asyncHandler(async (req, res) => {
  res.json({
    fields: all('SELECT * FROM custom_field_defs WHERE organization_id = ? ORDER BY entity_type, position',
      [req.auth.organizationId]).map((f) => ({ ...f, options: parseJson(f.options, []), required: Boolean(f.required), aiExtractable: Boolean(f.ai_extractable) })),
  });
}));

router.post('/custom-fields', requirePermission('customfield:write'), asyncHandler(async (req, res) => {
  const data = validate(req.body, {
    entityType: { type: 'string', required: true, enum: ['lead', 'deal', 'company'] },
    key: { type: 'string', required: true, maxLength: 60, pattern: /^[a-z][a-z0-9_]*$/, message: 'must be lowercase letters, numbers and underscores' },
    label: { type: 'string', required: true, maxLength: 120 },
    type: { type: 'string', required: true, enum: ['text', 'number', 'date', 'select', 'multiselect', 'boolean', 'currency'] },
    options: { type: 'array', of: 'string', maxItems: 50 },
    required: { type: 'boolean', default: false },
    aiExtractable: { type: 'boolean', default: false },
    aiHint: { type: 'string', maxLength: 300 },
    position: { type: 'number', integer: true, default: 100 },
  });
  const row = {
    id: id('cfd'),
    organization_id: req.auth.organizationId,
    entity_type: data.entityType,
    key: data.key,
    label: data.label,
    type: data.type,
    options: JSON.stringify(data.options || []),
    required: data.required ? 1 : 0,
    ai_extractable: data.aiExtractable ? 1 : 0,
    ai_hint: data.aiHint || null,
    position: data.position,
    created_at: nowIso(),
  };
  try {
    insert('custom_field_defs', row);
  } catch (error) {
    throw conflict(`A ${data.entityType} field with key "${data.key}" already exists`);
  }
  audit.recordFromRequest(req, { action: 'customfield.create', entityType: 'custom_field', entityId: row.id, after: row });
  res.status(201).json({ field: { ...row, options: data.options || [] } });
}));

router.delete('/custom-fields/:fieldId', requirePermission('customfield:write'), asyncHandler(async (req, res) => {
  const field = get('SELECT * FROM custom_field_defs WHERE id = ? AND organization_id = ?', [req.params.fieldId, req.auth.organizationId]);
  if (!field) throw notFound('Custom field');
  run('DELETE FROM custom_field_defs WHERE id = ?', [field.id]);
  audit.recordFromRequest(req, { action: 'customfield.delete', entityType: 'custom_field', entityId: field.id, before: field });
  res.json({ ok: true, note: 'Existing values are retained on records but no longer shown in forms.' });
}));

// ------------------------------------------------------- assignment rules ---
router.get('/assignment-rules', asyncHandler(async (req, res) => {
  res.json({
    rules: all('SELECT * FROM assignment_rules WHERE organization_id = ? ORDER BY priority ASC', [req.auth.organizationId])
      .map((r) => ({ ...r, conditions: parseJson(r.conditions, []), enabled: Boolean(r.enabled) })),
    operators: ['equals', 'not_equals', 'contains', 'in', 'gt', 'gte', 'lt', 'exists'],
    strategies: ['round_robin', 'specific_user', 'team_load', 'least_loaded'],
    fields: ['source', 'industry', 'country', 'location', 'temperature', 'dealValue', 'jobTitle', 'companyName'],
  });
}));

router.post('/assignment-rules', requirePermission('assignmentrule:write'), asyncHandler(async (req, res) => {
  const data = validate(req.body, {
    name: { type: 'string', required: true, maxLength: 120 },
    priority: { type: 'number', integer: true, min: 1, max: 1000, default: 100 },
    conditions: { type: 'array', maxItems: 10, default: [] },
    strategy: { type: 'string', enum: ['round_robin', 'specific_user', 'team_load', 'least_loaded'], default: 'round_robin' },
    targetUserId: { type: 'string', maxLength: 40 },
    targetTeamId: { type: 'string', maxLength: 40 },
    enabled: { type: 'boolean', default: true },
  });
  if (data.strategy === 'specific_user' && !data.targetUserId) throw badRequest('targetUserId is required for the specific_user strategy');
  const row = {
    id: id('asr'),
    organization_id: req.auth.organizationId,
    name: data.name,
    priority: data.priority,
    conditions: JSON.stringify(data.conditions),
    strategy: data.strategy,
    target_user_id: data.targetUserId || null,
    target_team_id: data.targetTeamId || null,
    enabled: data.enabled ? 1 : 0,
    cursor: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('assignment_rules', row);
  audit.recordFromRequest(req, { action: 'assignmentrule.create', entityType: 'assignment_rule', entityId: row.id, after: row });
  res.status(201).json({ rule: { ...row, conditions: data.conditions } });
}));

router.patch('/assignment-rules/:ruleId', requirePermission('assignmentrule:write'), asyncHandler(async (req, res) => {
  const before = get('SELECT * FROM assignment_rules WHERE id = ? AND organization_id = ?', [req.params.ruleId, req.auth.organizationId]);
  if (!before) throw notFound('Assignment rule');
  const patch = validate(req.body, {
    name: { type: 'string', maxLength: 120 },
    priority: { type: 'number', integer: true },
    conditions: { type: 'array' },
    strategy: { type: 'string', enum: ['round_robin', 'specific_user', 'team_load', 'least_loaded'] },
    targetUserId: { type: 'string', maxLength: 40 },
    targetTeamId: { type: 'string', maxLength: 40 },
    enabled: { type: 'boolean' },
  }, { partial: true });
  const columns = {
    name: patch.name,
    priority: patch.priority,
    conditions: patch.conditions ? JSON.stringify(patch.conditions) : undefined,
    strategy: patch.strategy,
    target_user_id: patch.targetUserId,
    target_team_id: patch.targetTeamId,
    enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0,
  };
  const keys = Object.keys(columns).filter((k) => columns[k] !== undefined);
  if (keys.length) {
    run(`UPDATE assignment_rules SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => columns[k]), nowIso(), before.id]);
  }
  res.json({ rule: get('SELECT * FROM assignment_rules WHERE id = ?', [before.id]) });
}));

router.delete('/assignment-rules/:ruleId', requirePermission('assignmentrule:write'), asyncHandler(async (req, res) => {
  run('DELETE FROM assignment_rules WHERE id = ? AND organization_id = ?', [req.params.ruleId, req.auth.organizationId]);
  res.json({ ok: true });
}));

// -------------------------------------------------------------- settings ----
router.get('/settings', asyncHandler(async (req, res) => {
  const organization = orgService.organization(req.auth.organizationId);
  res.json({
    organization: {
      id: organization.id, name: organization.name, slug: organization.slug, plan: organization.plan,
      seats: organization.seats, currency: organization.currency, timezone: organization.timezone,
    },
    settings: organization.settings,
    defaults: DEFAULT_ORG_SETTINGS,
    seatsUsed: get(`SELECT COUNT(*) AS n FROM users WHERE organization_id = ? AND status != 'suspended'`, [req.auth.organizationId])?.n || 0,
  });
}));

router.patch('/settings', requirePermission('security:write'), asyncHandler(async (req, res) => {
  const patch = req.body?.settings;
  if (!patch || typeof patch !== 'object') throw badRequest('A `settings` object is required');

  // Retention and full-automation changes are super-admin decisions.
  const requiresSuperAdmin = patch.dataRetention !== undefined
    || (patch.crmApproval && (patch.crmApproval.mode === 'auto' || patch.crmApproval.alwaysReviewSensitive === false));
  if (requiresSuperAdmin && req.auth.role !== 'super_admin') {
    throw forbidden('Changing retention or enabling fully automatic CRM updates requires a super admin');
  }

  const before = orgService.orgSettings(req.auth.organizationId);
  const settings = orgService.updateSettings(req.auth.organizationId, patch);
  audit.recordFromRequest(req, {
    action: 'org.settings.update', entityType: 'organization', entityId: req.auth.organizationId,
    before, after: settings,
  });
  res.json({ settings });
}));

router.patch('/organization', requireRole('super_admin'), asyncHandler(async (req, res) => {
  const patch = validate(req.body, {
    name: { type: 'string', maxLength: 160 },
    plan: { type: 'string', enum: ['starter', 'growth', 'enterprise'] },
    seats: { type: 'number', integer: true, min: 1, max: 10000 },
    currency: { type: 'string', maxLength: 4 },
    timezone: { type: 'string', maxLength: 60 },
  }, { partial: true });
  const columns = { name: patch.name, plan: patch.plan, seats: patch.seats, currency: patch.currency, timezone: patch.timezone };
  const keys = Object.keys(columns).filter((k) => columns[k] !== undefined);
  if (keys.length) {
    run(`UPDATE organizations SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => columns[k]), nowIso(), req.auth.organizationId]);
    orgService.invalidate(req.auth.organizationId);
  }
  audit.recordFromRequest(req, { action: 'org.update', entityType: 'organization', entityId: req.auth.organizationId, after: columns });
  res.json({ organization: orgService.organization(req.auth.organizationId) });
}));

// --------------------------------------------------------- integrations -----
const INTEGRATION_CATALOGUE = [
  { provider: 'google_mail', category: 'email', name: 'Google Workspace Mail', description: 'Send and log email from the agent inbox.' },
  { provider: 'microsoft_mail', category: 'email', name: 'Microsoft 365 Mail', description: 'Send and log email via Microsoft Graph.' },
  { provider: 'google_calendar', category: 'calendar', name: 'Google Calendar', description: 'Two-way meeting sync and availability.' },
  { provider: 'microsoft_calendar', category: 'calendar', name: 'Microsoft Calendar', description: 'Two-way meeting sync and availability.' },
  { provider: 'twilio', category: 'telephony', name: 'Twilio Voice', description: 'Outbound and inbound calling with recording.' },
  { provider: 'vonage', category: 'telephony', name: 'Vonage Voice', description: 'Alternative voice carrier.' },
  { provider: 'salesforce', category: 'crm', name: 'Salesforce', description: 'Bi-directional lead, contact and opportunity sync.' },
  { provider: 'hubspot', category: 'crm', name: 'HubSpot', description: 'Bi-directional contact and deal sync.' },
  { provider: 'slack', category: 'chat', name: 'Slack', description: 'Deal alerts and AI recommendations in channel.' },
  { provider: 'ms_teams', category: 'chat', name: 'Microsoft Teams', description: 'Deal alerts and AI recommendations in channel.' },
  { provider: 'twilio_sms', category: 'messaging', name: 'SMS (Twilio)', description: 'Outbound SMS with opt-out handling.' },
  { provider: 'whatsapp', category: 'messaging', name: 'WhatsApp Business', description: 'Template messaging where permitted.' },
  { provider: 'stripe', category: 'payments', name: 'Stripe', description: 'Subscription billing and payment links.' },
];

router.get('/integrations', asyncHandler(async (req, res) => {
  const connected = all('SELECT * FROM integrations WHERE organization_id = ?', [req.auth.organizationId]);
  res.json({
    integrations: INTEGRATION_CATALOGUE.map((entry) => {
      const record = connected.find((c) => c.provider === entry.provider);
      return {
        ...entry,
        status: record?.status || 'disconnected',
        // Credentials are never returned, only whether they exist.
        hasCredentials: Boolean(record?.credentials_enc),
        config: parseJson(record?.config, {}),
        lastSyncAt: record?.last_sync_at || null,
        lastError: record?.last_error || null,
      };
    }),
  });
}));

router.post('/integrations/:provider', requirePermission('integration:write'), asyncHandler(async (req, res) => {
  const entry = INTEGRATION_CATALOGUE.find((i) => i.provider === req.params.provider);
  if (!entry) throw notFound('Integration');
  const data = validate(req.body, {
    config: { type: 'object', default: {} },
    credentials: { type: 'object' },
    status: { type: 'string', enum: ['connected', 'disconnected', 'error'], default: 'connected' },
  }, { partial: true });

  const existing = get('SELECT * FROM integrations WHERE organization_id = ? AND provider = ?', [req.auth.organizationId, entry.provider]);
  const row = {
    id: existing?.id || id('int'),
    organization_id: req.auth.organizationId,
    provider: entry.provider,
    category: entry.category,
    status: data.status || 'connected',
    config: JSON.stringify(data.config || parseJson(existing?.config, {})),
    credentials_enc: data.credentials ? encrypt(JSON.stringify(data.credentials)) : existing?.credentials_enc || null,
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso(),
  };
  if (existing) {
    run(`UPDATE integrations SET status = ?, config = ?, credentials_enc = ?, updated_at = ? WHERE id = ?`,
      [row.status, row.config, row.credentials_enc, row.updated_at, existing.id]);
  } else {
    insert('integrations', row);
  }
  audit.recordFromRequest(req, {
    action: 'integration.configure', entityType: 'integration', entityId: row.id,
    after: { provider: entry.provider, status: row.status, hasCredentials: Boolean(row.credentials_enc) },
  });
  res.json({ integration: { provider: entry.provider, status: row.status, config: parseJson(row.config, {}), hasCredentials: Boolean(row.credentials_enc) } });
}));

router.delete('/integrations/:provider', requirePermission('integration:write'), asyncHandler(async (req, res) => {
  run('DELETE FROM integrations WHERE organization_id = ? AND provider = ?', [req.auth.organizationId, req.params.provider]);
  audit.recordFromRequest(req, { action: 'integration.disconnect', entityType: 'integration', entityId: req.params.provider });
  res.json({ ok: true });
}));

// ------------------------------------------------------------- webhooks -----
router.get('/webhooks', asyncHandler(async (req, res) => {
  res.json({
    webhooks: all('SELECT id, url, events, enabled, failure_count, last_status, last_delivered_at, created_at FROM webhooks WHERE organization_id = ?',
      [req.auth.organizationId]).map((w) => ({ ...w, events: parseJson(w.events, []), enabled: Boolean(w.enabled) })),
    availableEvents: WEBHOOK_EVENTS,
    recentDeliveries: all(
      `SELECT id, webhook_id, event, status_code, error, attempt, created_at FROM webhook_deliveries
       WHERE organization_id = ? ORDER BY created_at DESC LIMIT 30`,
      [req.auth.organizationId],
    ),
  });
}));

router.post('/webhooks', requirePermission('webhook:write'), asyncHandler(async (req, res) => {
  const data = validate(req.body, {
    url: { type: 'string', required: true, maxLength: 500, pattern: /^https?:\/\/.+/, message: 'must be an http(s) URL' },
    events: { type: 'array', of: 'string', required: true, maxItems: 40 },
  });
  const unknown = data.events.filter((event) => event !== '*' && !WEBHOOK_EVENTS.includes(event));
  if (unknown.length) throw badRequest(`Unknown events: ${unknown.join(', ')}`);

  const secret = randomToken(32);
  const row = {
    id: id('whk'),
    organization_id: req.auth.organizationId,
    url: data.url,
    events: JSON.stringify(data.events),
    secret,
    enabled: 1,
    failure_count: 0,
    created_at: nowIso(),
  };
  insert('webhooks', row);
  audit.recordFromRequest(req, { action: 'webhook.create', entityType: 'webhook', entityId: row.id, after: { url: data.url, events: data.events } });
  res.status(201).json({
    webhook: { ...row, events: data.events, enabled: true },
    // Shown once so the receiver can verify signatures.
    signingSecret: secret,
    signatureHeader: 'X-SalesOS-Signature',
  });
}));

router.delete('/webhooks/:webhookId', requirePermission('webhook:write'), asyncHandler(async (req, res) => {
  run('DELETE FROM webhooks WHERE id = ? AND organization_id = ?', [req.params.webhookId, req.auth.organizationId]);
  res.json({ ok: true });
}));

// ------------------------------------------------------------- API keys -----
router.get('/api-keys', requirePermission('apikey:write'), asyncHandler(async (req, res) => {
  res.json({
    keys: all(
      `SELECT id, name, prefix, scopes, created_by, last_used_at, revoked_at, created_at
       FROM api_keys WHERE organization_id = ? ORDER BY created_at DESC`,
      [req.auth.organizationId],
    ).map((k) => ({ ...k, scopes: parseJson(k.scopes, []) })),
  });
}));

router.post('/api-keys', requirePermission('apikey:write'), asyncHandler(async (req, res) => {
  const data = validate(req.body, {
    name: { type: 'string', required: true, maxLength: 120 },
    scopes: { type: 'array', of: 'string', maxItems: 40, default: ['*'] },
  });
  const key = `sos_${randomToken(24)}`;
  const row = {
    id: id('key'),
    organization_id: req.auth.organizationId,
    name: data.name,
    prefix: key.slice(0, 8),
    key_hash: sha256(key),
    scopes: JSON.stringify(data.scopes),
    created_by: req.auth.userId,
    created_at: nowIso(),
  };
  insert('api_keys', row);
  audit.recordFromRequest(req, { action: 'apikey.create', entityType: 'api_key', entityId: row.id, after: { name: data.name, prefix: row.prefix } });
  res.status(201).json({
    apiKey: { id: row.id, name: row.name, prefix: row.prefix, scopes: data.scopes, createdAt: row.created_at },
    // The only time the full key is ever visible.
    key,
  });
}));

router.delete('/api-keys/:keyId', requirePermission('apikey:write'), asyncHandler(async (req, res) => {
  run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND organization_id = ?', [nowIso(), req.params.keyId, req.auth.organizationId]);
  audit.recordFromRequest(req, { action: 'apikey.revoke', entityType: 'api_key', entityId: req.params.keyId });
  res.json({ ok: true });
}));

// ------------------------------------------------------------ audit logs ----
router.get('/audit', requirePermission('audit:read'), asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 500 });
  const entries = audit.list({
    organizationId: req.auth.organizationId,
    entityType: req.query.entityType,
    entityId: req.query.entityId,
    actorId: req.query.actorId,
    actorType: req.query.actorType,
    action: req.query.action,
    since: req.query.since,
    limit,
    offset,
  });
  res.json({
    audit: entries.map((entry) => ({
      ...entry,
      before: parseJson(entry.before, null),
      after: parseJson(entry.after, null),
      diff: parseJson(entry.diff, null),
    })),
    total: audit.count({ organizationId: req.auth.organizationId, since: req.query.since }),
    limit,
    offset,
  });
}));

// ------------------------------------------------------- system & health ----
router.get('/system', requirePermission('audit:read'), asyncHandler(async (req, res) => {
  res.json({
    queue: queue.stats(req.auth.organizationId),
    jobs: queue.listJobs({ organizationId: req.auth.organizationId, status: req.query.jobStatus, limit: 40 }),
    ai: ai.usageSummary({ organizationId: req.auth.organizationId, since: startOfDay(new Date(), -7) }),
    realtimeConnections: connectionCount(),
    counts: {
      leads: get('SELECT COUNT(*) AS n FROM leads WHERE organization_id = ?', [req.auth.organizationId])?.n || 0,
      deals: get('SELECT COUNT(*) AS n FROM deals WHERE organization_id = ?', [req.auth.organizationId])?.n || 0,
      calls: get('SELECT COUNT(*) AS n FROM calls WHERE organization_id = ?', [req.auth.organizationId])?.n || 0,
      transcripts: get('SELECT COUNT(*) AS n FROM transcripts WHERE organization_id = ?', [req.auth.organizationId])?.n || 0,
      auditEntries: audit.count({ organizationId: req.auth.organizationId }),
    },
  });
}));

router.post('/jobs/:jobId/retry', requirePermission('audit:read'), asyncHandler(async (req, res) => {
  const changed = queue.retryJob(req.params.jobId);
  if (!changed) throw notFound('Job');
  res.json({ ok: true });
}));

router.post('/reindex', requirePermission('security:write'), asyncHandler(async (req, res) => {
  const count = reindexOrganization(req.auth.organizationId);
  audit.recordFromRequest(req, { action: 'search.reindex', entityType: 'organization', entityId: req.auth.organizationId, after: { records: count } });
  res.json({ ok: true, indexed: count });
}));

// ------------------------------------------------------------- billing -----
router.get('/billing', requirePermission('billing:read'), asyncHandler(async (req, res) => {
  const organization = orgService.organization(req.auth.organizationId);
  const seatsUsed = get(`SELECT COUNT(*) AS n FROM users WHERE organization_id = ? AND status != 'suspended'`, [req.auth.organizationId])?.n || 0;
  const usage = ai.usageSummary({ organizationId: req.auth.organizationId, since: startOfDay(new Date(), -30) });
  const PLAN_PRICES = { starter: 39, growth: 79, enterprise: 129 };
  const seatPrice = PLAN_PRICES[organization.plan] || 79;

  res.json({
    plan: organization.plan,
    seatPrice,
    currency: organization.currency,
    seats: organization.seats,
    seatsUsed,
    monthlySubscription: seatPrice * organization.seats,
    period: { since: startOfDay(new Date(), -30), until: nowIso() },
    usage: {
      calls: get(`SELECT COUNT(*) AS n FROM calls WHERE organization_id = ? AND created_at >= ?`, [req.auth.organizationId, startOfDay(new Date(), -30)])?.n || 0,
      transcriptionMinutes: Math.round((get(`SELECT COALESCE(SUM(duration_seconds), 0) AS s FROM transcripts WHERE organization_id = ? AND created_at >= ?`, [req.auth.organizationId, startOfDay(new Date(), -30)])?.s || 0) / 60),
      aiRequests: usage.totals.calls,
      aiTokens: usage.totals.inputTokens + usage.totals.outputTokens,
    },
    integration: get(`SELECT status FROM integrations WHERE organization_id = ? AND provider = 'stripe'`, [req.auth.organizationId])?.status || 'disconnected',
  });
}));

// ---------------------------------------------------------- permissions ----
router.get('/permissions', asyncHandler(async (req, res) => {
  res.json({
    matrix: Object.entries(PERMISSIONS).map(([permission, minimumRole]) => ({
      permission,
      minimumRole,
      roles: Object.fromEntries(ROLES.map((role) => [role, permissionsFor(role).includes(permission)])),
    })),
    roles: ROLES.map((role) => ({ key: role, label: ROLE_LABELS[role] })),
  });
}));

export default router;
