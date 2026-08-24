/**
 * Role-based access control.
 *
 * Two dimensions are enforced independently:
 *  1. `can(role, permission)` -- may this role perform the action at all?
 *  2. `scopeFor(user, resource)` -- which records may they see? Agents are
 *     limited to their own records, managers to their team, admins to the org.
 *
 * Organisation isolation is enforced separately and unconditionally: every
 * query is filtered by `organization_id` from the authenticated token.
 */

export const ROLES = ['agent', 'manager', 'admin', 'super_admin'];
export const ROLE_LABELS = {
  agent: 'Sales Agent',
  manager: 'Sales Manager',
  admin: 'Admin',
  super_admin: 'Super Admin',
};

// Ordered so `atLeast()` comparisons are cheap and readable.
const RANK = { agent: 1, manager: 2, admin: 3, super_admin: 4 };

export const PERMISSIONS = {
  // CRM
  'lead:read': 'agent',
  'lead:write': 'agent',
  'lead:delete': 'manager',
  'lead:import': 'agent',
  'lead:assign': 'manager',
  'lead:export': 'manager',
  'company:read': 'agent',
  'company:write': 'agent',
  'deal:read': 'agent',
  'deal:write': 'agent',
  'deal:delete': 'manager',
  // Communication
  'call:place': 'agent',
  'call:read': 'agent',
  'call:recording:listen': 'agent',
  'call:recording:delete': 'admin',
  'transcript:read': 'agent',
  'email:send': 'agent',
  'email:read': 'agent',
  'message:send': 'agent',
  'meeting:write': 'agent',
  'task:write': 'agent',
  'note:write': 'agent',
  // AI
  'ai:assistant': 'agent',
  'ai:analyze': 'agent',
  'ai:suggestion:approve': 'agent',
  'ai:suggestion:approve:sensitive': 'agent',
  'ai:settings': 'admin',
  // Insight
  'analytics:read': 'agent',
  'analytics:team': 'manager',
  'analytics:org': 'admin',
  'coaching:read': 'agent',
  'coaching:review': 'manager',
  'report:export': 'agent',
  // Administration
  'user:read': 'manager',
  'user:write': 'admin',
  'team:write': 'admin',
  'customfield:write': 'admin',
  'assignmentrule:write': 'admin',
  'integration:write': 'admin',
  'webhook:write': 'admin',
  'apikey:write': 'admin',
  'audit:read': 'admin',
  'security:write': 'admin',
  'billing:read': 'admin',
  'billing:write': 'super_admin',
  'org:write': 'super_admin',
  'org:delete': 'super_admin',
  'retention:write': 'super_admin',
};

export function atLeast(role, minimum) {
  return (RANK[role] || 0) >= (RANK[minimum] || 99);
}

export function can(role, permission) {
  const required = PERMISSIONS[permission];
  if (!required) return false;
  return atLeast(role, required);
}

export function permissionsFor(role) {
  return Object.keys(PERMISSIONS).filter((p) => can(role, p));
}

/**
 * Visibility scope for record-level filtering.
 *  - own:  only records owned by / assigned to the user
 *  - team: records owned by anyone on the user's team (managers)
 *  - org:  every record in the organisation (admin, super admin)
 */
export function visibilityScope(user) {
  if (atLeast(user.role, 'admin')) return 'org';
  if (user.role === 'manager') return 'team';
  return 'own';
}

/** True when `user` may act on a record owned by `ownerId`. */
export function canAccessRecord(user, ownerId, teammateIds = []) {
  const scope = visibilityScope(user);
  if (scope === 'org') return true;
  if (!ownerId) return scope !== 'own';
  if (ownerId === user.id) return true;
  if (scope === 'team') return teammateIds.includes(ownerId);
  return false;
}

export default { ROLES, ROLE_LABELS, PERMISSIONS, can, atLeast, permissionsFor, visibilityScope, canAccessRecord };
