import { useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import api from '../lib/api.js';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import {
  PageHeader, Card, Badge, Stat, Spinner, ErrorState, EmptyState, DataTable, Modal,
  Drawer, TextField, TextArea, SelectField, Switch, KeyValue, useToast, Avatar, Tabs, Checkbox,
} from '../components/UI.jsx';
import {
  IconUsers, IconSettings, IconShield, IconLink, IconKey, IconFile, IconGrid,
  IconPlus, IconTrash, IconRefresh, IconCheck, IconAlert, IconRobot, IconTarget,
  IconClock, IconEdit, IconExternal, IconDownload,
} from '../components/Icons.jsx';
import { money, number, percent, titleCase, dateTime, relative, date } from '../lib/format.js';

/**
 * Admin panel.
 *
 * Grouped the way an administrator thinks: who can do what, how the CRM is
 * shaped, how AI behaves, what we connect to, and what happened. Every
 * destructive or policy-level control states its consequence in the UI rather
 * than hiding it in documentation.
 */

const SECTIONS = [
  { to: 'users', label: 'Users', icon: <IconUsers size={14} /> },
  { to: 'teams', label: 'Teams', icon: <IconTarget size={14} /> },
  { to: 'fields', label: 'Custom fields', icon: <IconGrid size={14} /> },
  { to: 'assignment', label: 'Lead assignment', icon: <IconRefresh size={14} /> },
  { to: 'ai', label: 'AI settings', icon: <IconRobot size={14} /> },
  { to: 'calls', label: 'Calls and recording', icon: <IconShield size={14} /> },
  { to: 'integrations', label: 'Integrations', icon: <IconLink size={14} /> },
  { to: 'api', label: 'API and webhooks', icon: <IconKey size={14} /> },
  { to: 'security', label: 'Security and retention', icon: <IconShield size={14} /> },
  { to: 'audit', label: 'Audit log', icon: <IconFile size={14} /> },
  { to: 'system', label: 'System', icon: <IconSettings size={14} /> },
  { to: 'billing', label: 'Billing', icon: <IconDownload size={14} /> },
];

/* ---------------------------------------------------------------- users --- */
function Users() {
  const toast = useToast();
  const { user: currentUser, can } = useAuth();
  const { data, loading, error, refetch } = useApi('/admin/users');
  const teams = useApi('/admin/teams');
  const [showInvite, setShowInvite] = useState(false);
  const [editing, setEditing] = useState(null);
  const [credential, setCredential] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', role: 'agent', teamId: '', title: '', phone: '', quota: 0 });

  const invite = async (event) => {
    event.preventDefault();
    try {
      const result = await api.post('/admin/users', { ...form, quota: Number(form.quota) || 0, teamId: form.teamId || undefined });
      setShowInvite(false);
      setForm({ name: '', email: '', role: 'agent', teamId: '', title: '', phone: '', quota: 0 });
      if (result.temporaryPassword) {
        setCredential({ email: result.user.email, password: result.temporaryPassword });
      }
      toast.success(`${result.user.name} added`);
      refetch();
    } catch (caught) {
      toast.error(caught);
    }
  };

  const save = async () => {
    try {
      const result = await api.patch(`/admin/users/${editing.id}`, {
        name: editing.name,
        role: editing.role,
        teamId: editing.teamId || null,
        title: editing.title,
        phone: editing.phone,
        quota: Number(editing.quota) || 0,
        status: editing.status,
      });
      toast.success('User updated');
      setEditing(null);
      refetch();
      if (result.temporaryPassword) setCredential({ email: result.user.email, password: result.temporaryPassword });
    } catch (caught) {
      toast.error(caught);
    }
  };

  const resetPassword = async (target) => {
    try {
      const result = await api.patch(`/admin/users/${target.id}`, { resetPassword: true });
      setCredential({ email: target.email, password: result.temporaryPassword });
      toast.success('Password reset. All their sessions were signed out.');
    } catch (caught) {
      toast.error(caught);
    }
  };

  if (loading && !data) return <Spinner label="Loading users" />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;

  return (
    <>
      <Card
        title="Users"
        subtitle={`${data.users.length} accounts`}
        actions={can('user:write') && <button type="button" className="btn primary sm" onClick={() => setShowInvite(true)}><IconPlus /> Add user</button>}
        flush
      >
        <DataTable
          columns={[
            {
              key: 'name',
              label: 'User',
              render: (row) => (
                <div className="row-tight">
                  <Avatar name={row.name} color={row.avatarColor} size="sm" />
                  <div className="col-tight" style={{ gap: 0, minWidth: 0 }}>
                    <span className="cell-primary truncate">{row.name}{row.id === currentUser?.id ? ' (you)' : ''}</span>
                    <span className="cell-sub truncate">{row.email}</span>
                  </div>
                </div>
              ),
            },
            { key: 'role', label: 'Role', render: (row) => <Badge tone={row.role === 'super_admin' ? 'purple' : row.role === 'admin' ? 'accent' : 'outline'}>{row.roleLabel}</Badge> },
            { key: 'team', label: 'Team', render: (row) => <span className="small">{row.teamName || '--'}</span> },
            { key: 'leads', label: 'Leads', numeric: true, render: (row) => <span className="tabular">{number(row.leadCount)}</span> },
            { key: 'deals', label: 'Open deals', numeric: true, render: (row) => <span className="tabular">{number(row.openDeals)}</span> },
            { key: 'quota', label: 'Quota', numeric: true, render: (row) => <span className="tabular">{row.quota ? money(row.quota, undefined, { compact: true }) : '--'}</span> },
            { key: 'status', label: 'Status', render: (row) => <Badge tone={row.status === 'active' ? 'success' : row.status === 'invited' ? 'warning' : 'danger'}>{row.status}</Badge> },
            { key: 'lastLogin', label: 'Last login', render: (row) => <span className="small nowrap">{row.lastLoginAt ? relative(row.lastLoginAt) : 'never'}</span> },
            ...(can('user:write') ? [{
              key: 'actions',
              label: '',
              width: 90,
              render: (row) => (
                <div className="row-tight">
                  <button type="button" className="btn sm ghost icon" aria-label="Edit user" onClick={() => setEditing({ ...row, teamId: row.teamId || '' })}><IconEdit size={13} /></button>
                  <button type="button" className="btn sm ghost icon" aria-label="Reset password" title="Reset password" onClick={() => resetPassword(row)}><IconKey size={13} /></button>
                </div>
              ),
            }] : []),
          ]}
          rows={data.users}
        />
      </Card>

      <Card title="Roles and permissions" subtitle="What each role can do">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Role</th><th>Permissions</th></tr>
            </thead>
            <tbody>
              {data.roles.map((role) => (
                <tr key={role.key}>
                  <td className="cell-primary nowrap">{role.label}</td>
                  <td>
                    <div className="tag-list">
                      {role.permissions.map((permission) => <span key={permission} className="chip mono">{permission}</span>)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        title="Add a user"
        footer={(
          <>
            <button type="button" className="btn" onClick={() => setShowInvite(false)}>Cancel</button>
            <button type="submit" form="invite-form" className="btn primary" disabled={!form.name || !form.email}>Create</button>
          </>
        )}
      >
        <form id="invite-form" className="col" onSubmit={invite}>
          <div className="grid grid-2">
            <TextField label="Name" value={form.name} onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))} required autoFocus />
            <TextField label="Email" type="email" value={form.email} onChange={(e) => setForm((c) => ({ ...c, email: e.target.value }))} required />
            <SelectField
              label="Role"
              value={form.role}
              onChange={(e) => setForm((c) => ({ ...c, role: e.target.value }))}
              options={(data.roles || []).filter((role) => role.key !== 'super_admin' || currentUser?.role === 'super_admin')
                .map((role) => ({ value: role.key, label: role.label }))}
            />
            <SelectField
              label="Team"
              value={form.teamId}
              placeholder="No team"
              onChange={(e) => setForm((c) => ({ ...c, teamId: e.target.value }))}
              options={(teams.data?.teams || []).map((team) => ({ value: team.id, label: team.name }))}
            />
            <TextField label="Job title" value={form.title} onChange={(e) => setForm((c) => ({ ...c, title: e.target.value }))} />
            <TextField label="Monthly quota" type="number" value={form.quota} onChange={(e) => setForm((c) => ({ ...c, quota: e.target.value }))} />
          </div>
          <span className="xs muted">A temporary password is generated and shown once. The user must change it on first sign-in.</span>
        </form>
      </Modal>

      <Drawer open={Boolean(editing)} onClose={() => setEditing(null)} title={`Edit ${editing?.name || ''}`} footer={<button type="button" className="btn primary block" onClick={save}>Save changes</button>}>
        {editing && (
          <div className="col">
            <TextField label="Name" value={editing.name} onChange={(e) => setEditing((c) => ({ ...c, name: e.target.value }))} />
            <SelectField
              label="Role"
              value={editing.role}
              onChange={(e) => setEditing((c) => ({ ...c, role: e.target.value }))}
              options={(data.roles || []).filter((role) => role.key !== 'super_admin' || currentUser?.role === 'super_admin')
                .map((role) => ({ value: role.key, label: role.label }))}
            />
            <SelectField
              label="Team"
              value={editing.teamId}
              placeholder="No team"
              onChange={(e) => setEditing((c) => ({ ...c, teamId: e.target.value }))}
              options={(teams.data?.teams || []).map((team) => ({ value: team.id, label: team.name }))}
            />
            <TextField label="Job title" value={editing.title || ''} onChange={(e) => setEditing((c) => ({ ...c, title: e.target.value }))} />
            <TextField label="Phone" value={editing.phone || ''} onChange={(e) => setEditing((c) => ({ ...c, phone: e.target.value }))} />
            <TextField label="Monthly quota" type="number" value={editing.quota || 0} onChange={(e) => setEditing((c) => ({ ...c, quota: e.target.value }))} />
            <SelectField
              label="Status"
              value={editing.status}
              onChange={(e) => setEditing((c) => ({ ...c, status: e.target.value }))}
              options={['active', 'invited', 'suspended'].map((value) => ({ value, label: titleCase(value) }))}
            />
            {editing.status === 'suspended' && (
              <div className="banner warning small"><IconAlert /> Suspending signs the user out everywhere and blocks sign-in. Their records stay assigned to them.</div>
            )}
          </div>
        )}
      </Drawer>

      <Modal open={Boolean(credential)} onClose={() => setCredential(null)} title="Temporary credentials">
        <div className="banner warning small">
          <IconAlert />
          <span>Shown once. Share it over a secure channel — it is not recoverable afterwards.</span>
        </div>
        <KeyValue items={[
          { label: 'Email', value: <span className="mono">{credential?.email}</span> },
          { label: 'Password', value: <span className="mono strong">{credential?.password}</span> },
        ]}
        />
      </Modal>
    </>
  );
}

/* ---------------------------------------------------------------- teams --- */
function Teams() {
  const toast = useToast();
  const { data, loading, refetch } = useApi('/admin/teams');
  const users = useApi('/admin/users');
  const [form, setForm] = useState({ name: '', region: '', managerId: '' });

  const create = async (event) => {
    event.preventDefault();
    try {
      await api.post('/admin/teams', { ...form, managerId: form.managerId || undefined });
      toast.success('Team created');
      setForm({ name: '', region: '', managerId: '' });
      refetch();
    } catch (error) {
      toast.error(error);
    }
  };

  if (loading && !data) return <Spinner />;

  return (
    <div className="grid grid-main">
      <Card title="Teams" flush>
        <DataTable
          columns={[
            { key: 'name', label: 'Team', render: (team) => <span className="cell-primary">{team.name}</span> },
            { key: 'region', label: 'Region', render: (team) => <span className="small">{team.region || '--'}</span> },
            { key: 'manager', label: 'Manager', render: (team) => <span className="small">{team.manager_name || 'Unassigned'}</span> },
            { key: 'members', label: 'Members', numeric: true, render: (team) => <span className="tabular">{team.member_count}</span> },
          ]}
          rows={data?.teams || []}
          empty={<EmptyState title="No teams yet" message="Teams scope what a manager can see." />}
        />
      </Card>

      <Card title="New team">
        <form className="col" onSubmit={create}>
          <TextField label="Name" value={form.name} onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))} required />
          <TextField label="Region" value={form.region} onChange={(e) => setForm((c) => ({ ...c, region: e.target.value }))} placeholder="EMEA" />
          <SelectField
            label="Manager"
            value={form.managerId}
            placeholder="Choose a manager"
            onChange={(e) => setForm((c) => ({ ...c, managerId: e.target.value }))}
            options={(users.data?.users || []).filter((user) => user.role !== 'agent').map((user) => ({ value: user.id, label: user.name }))}
          />
          <button type="submit" className="btn primary" disabled={!form.name}>Create team</button>
          <span className="xs muted">A manager sees every record owned by anyone on their team.</span>
        </form>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------- custom fields --- */
function CustomFields() {
  const toast = useToast();
  const { data, loading, refetch } = useApi('/admin/custom-fields');
  const [form, setForm] = useState({
    entityType: 'lead', key: '', label: '', type: 'text', options: '', aiExtractable: true, aiHint: '',
  });

  const create = async (event) => {
    event.preventDefault();
    try {
      await api.post('/admin/custom-fields', {
        ...form,
        options: form.options ? form.options.split(',').map((s) => s.trim()).filter(Boolean) : [],
      });
      toast.success('Field created');
      setForm({ entityType: 'lead', key: '', label: '', type: 'text', options: '', aiExtractable: true, aiHint: '' });
      refetch();
    } catch (error) {
      toast.error(error);
    }
  };

  if (loading && !data) return <Spinner />;

  return (
    <div className="grid grid-main">
      <Card title="Custom fields" subtitle="Extend leads, deals and companies without a migration" flush>
        <DataTable
          columns={[
            { key: 'label', label: 'Field', render: (field) => <div className="col-tight" style={{ gap: 0 }}><span className="cell-primary">{field.label}</span><span className="cell-sub mono">{field.key}</span></div> },
            { key: 'entity', label: 'On', render: (field) => <Badge tone="outline">{titleCase(field.entity_type)}</Badge> },
            { key: 'type', label: 'Type', render: (field) => <span className="small">{titleCase(field.type)}</span> },
            {
              key: 'ai',
              label: 'AI extraction',
              render: (field) => (field.aiExtractable
                ? <Badge tone="accent" title={field.ai_hint || 'Extracted from conversations'}><IconRobot size={10} /> enabled</Badge>
                : <span className="muted small">off</span>),
            },
            {
              key: 'actions',
              label: '',
              width: 44,
              render: (field) => (
                <button
                  type="button"
                  className="btn sm ghost icon"
                  aria-label={`Delete ${field.label}`}
                  onClick={async () => {
                    await api.del(`/admin/custom-fields/${field.id}`);
                    toast.info('Field removed from forms. Existing values are retained.');
                    refetch();
                  }}
                >
                  <IconTrash size={13} />
                </button>
              ),
            },
          ]}
          rows={data?.fields || []}
          empty={<EmptyState title="No custom fields" message="Add one to capture something specific to your business." />}
        />
      </Card>

      <Card title="New field">
        <form className="col" onSubmit={create}>
          <SelectField
            label="Applies to"
            value={form.entityType}
            onChange={(e) => setForm((c) => ({ ...c, entityType: e.target.value }))}
            options={['lead', 'deal', 'company'].map((value) => ({ value, label: titleCase(value) }))}
          />
          <TextField label="Label" value={form.label} onChange={(e) => setForm((c) => ({ ...c, label: e.target.value, key: c.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') }))} required />
          <TextField label="Key" value={form.key} onChange={(e) => setForm((c) => ({ ...c, key: e.target.value }))} hint="lowercase, underscores" required />
          <SelectField
            label="Type"
            value={form.type}
            onChange={(e) => setForm((c) => ({ ...c, type: e.target.value }))}
            options={['text', 'number', 'date', 'select', 'multiselect', 'boolean', 'currency'].map((value) => ({ value, label: titleCase(value) }))}
          />
          {['select', 'multiselect'].includes(form.type) && (
            <TextField label="Options" value={form.options} onChange={(e) => setForm((c) => ({ ...c, options: e.target.value }))} hint="Comma separated" />
          )}
          <Switch
            checked={form.aiExtractable}
            onChange={(value) => setForm((c) => ({ ...c, aiExtractable: value }))}
            label="Let the AI fill this from conversations"
          />
          {form.aiExtractable && (
            <TextArea
              label="Extraction hint"
              value={form.aiHint}
              onChange={(e) => setForm((c) => ({ ...c, aiHint: e.target.value }))}
              rows={2}
              hint="Tell the model what to look for, e.g. 'the CRM the prospect uses today'"
            />
          )}
          <button type="submit" className="btn primary" disabled={!form.label || !form.key}>Create field</button>
        </form>
      </Card>
    </div>
  );
}

/* ----------------------------------------------------- assignment rules --- */
function Assignment() {
  const toast = useToast();
  const { data, loading, refetch } = useApi('/admin/assignment-rules');
  const users = useApi('/admin/users');
  const teams = useApi('/admin/teams');
  const [form, setForm] = useState({ name: '', priority: 100, strategy: 'round_robin', targetUserId: '', targetTeamId: '', field: 'source', op: 'equals', value: '' });

  const create = async (event) => {
    event.preventDefault();
    try {
      await api.post('/admin/assignment-rules', {
        name: form.name,
        priority: Number(form.priority),
        strategy: form.strategy,
        targetUserId: form.targetUserId || undefined,
        targetTeamId: form.targetTeamId || undefined,
        conditions: form.value ? [{ field: form.field, op: form.op, value: form.value }] : [],
      });
      toast.success('Rule created');
      setForm({ ...form, name: '', value: '' });
      refetch();
    } catch (error) {
      toast.error(error);
    }
  };

  if (loading && !data) return <Spinner />;

  return (
    <div className="grid grid-main">
      <Card title="Lead assignment rules" subtitle="Evaluated in priority order; the first match wins" flush>
        <DataTable
          columns={[
            { key: 'priority', label: '#', numeric: true, width: 50, render: (rule) => <span className="tabular muted">{rule.priority}</span> },
            { key: 'name', label: 'Rule', render: (rule) => <span className="cell-primary">{rule.name}</span> },
            {
              key: 'conditions',
              label: 'When',
              render: (rule) => (rule.conditions.length
                ? <span className="small mono">{rule.conditions.map((condition) => `${condition.field} ${condition.op} ${condition.value}`).join(' AND ')}</span>
                : <span className="muted small">always</span>),
            },
            { key: 'strategy', label: 'Assign', render: (rule) => <Badge tone="outline">{titleCase(rule.strategy)}</Badge> },
            {
              key: 'enabled',
              label: 'Enabled',
              render: (rule) => (
                <Switch
                  checked={rule.enabled}
                  onChange={async (value) => {
                    await api.patch(`/admin/assignment-rules/${rule.id}`, { enabled: value });
                    refetch();
                  }}
                />
              ),
            },
            {
              key: 'actions',
              label: '',
              width: 44,
              render: (rule) => (
                <button
                  type="button"
                  className="btn sm ghost icon"
                  aria-label={`Delete ${rule.name}`}
                  onClick={async () => {
                    await api.del(`/admin/assignment-rules/${rule.id}`);
                    toast.info('Rule deleted');
                    refetch();
                  }}
                >
                  <IconTrash size={13} />
                </button>
              ),
            },
          ]}
          rows={data?.rules || []}
          empty={<EmptyState title="No rules" message="Without a rule, new leads go to the least loaded active agent." />}
        />
      </Card>

      <Card title="New rule">
        <form className="col" onSubmit={create}>
          <TextField label="Name" value={form.name} onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))} required />
          <TextField label="Priority" type="number" value={form.priority} onChange={(e) => setForm((c) => ({ ...c, priority: e.target.value }))} hint="Lower runs first" />
          <div className="grid grid-2">
            <SelectField
              label="Field"
              value={form.field}
              onChange={(e) => setForm((c) => ({ ...c, field: e.target.value }))}
              options={(data?.fields || []).map((value) => ({ value, label: titleCase(value) }))}
            />
            <SelectField
              label="Operator"
              value={form.op}
              onChange={(e) => setForm((c) => ({ ...c, op: e.target.value }))}
              options={(data?.operators || []).map((value) => ({ value, label: titleCase(value) }))}
            />
          </div>
          <TextField label="Value" value={form.value} onChange={(e) => setForm((c) => ({ ...c, value: e.target.value }))} hint="Leave blank to match every lead" />
          <SelectField
            label="Strategy"
            value={form.strategy}
            onChange={(e) => setForm((c) => ({ ...c, strategy: e.target.value }))}
            options={(data?.strategies || []).map((value) => ({ value, label: titleCase(value) }))}
          />
          {form.strategy === 'specific_user' ? (
            <SelectField
              label="Assign to"
              value={form.targetUserId}
              placeholder="Choose a user"
              onChange={(e) => setForm((c) => ({ ...c, targetUserId: e.target.value }))}
              options={(users.data?.users || []).map((user) => ({ value: user.id, label: user.name }))}
            />
          ) : (
            <SelectField
              label="Within team"
              value={form.targetTeamId}
              placeholder="All agents"
              onChange={(e) => setForm((c) => ({ ...c, targetTeamId: e.target.value }))}
              options={(teams.data?.teams || []).map((team) => ({ value: team.id, label: team.name }))}
            />
          )}
          <button type="submit" className="btn primary" disabled={!form.name}>Create rule</button>
        </form>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------ AI settings --- */
function AiSettings() {
  const toast = useToast();
  const { settings, updateSettings, user } = useAuth();
  const status = useApi('/ai/status');
  const usage = useApi('/ai/usage');

  const patch = async (section, value) => {
    try {
      const result = await api.patch('/admin/settings', { settings: { [section]: value } });
      updateSettings(result.settings);
      toast.success('AI settings updated');
    } catch (error) {
      toast.error(error);
    }
  };

  const ai = settings?.ai || {};
  const approval = settings?.crmApproval || {};
  const transcription = settings?.transcription || {};

  return (
    <div className="col">
      <Card title="AI provider" subtitle="What is running right now">
        {status.loading ? <Spinner /> : status.data && (
          <>
            <KeyValue items={[
              { label: 'Active provider', value: <Badge tone={status.data.activeProvider === 'anthropic' ? 'accent' : 'outline'}>{status.data.activeProvider}</Badge> },
              { label: 'Model', value: <span className="mono">{status.data.model}</span> },
              { label: 'Configured mode', value: titleCase(status.data.configured) },
              { label: 'Prompt version', value: <span className="mono">{status.data.promptVersion}</span> },
            ]}
            />
            {!status.data.modelAvailable && (
              <div className="banner small">
                <IconRobot />
                <span>
                  No language-model key is configured, so the built-in deterministic engine is handling transcription,
                  analysis, extraction and email drafting. Set <span className="mono">ANTHROPIC_API_KEY</span> to switch
                  to model-backed analysis — the feature set and data shapes are identical.
                </span>
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="Features">
        <div className="grid grid-2">
          <Switch checked={ai.analysisEnabled !== false} onChange={(value) => patch('ai', { analysisEnabled: value })} label="Analyse calls after they end" />
          <Switch checked={ai.emailGenerationEnabled !== false} onChange={(value) => patch('ai', { emailGenerationEnabled: value })} label="AI email drafting" />
          <Switch checked={ai.assistantEnabled !== false} onChange={(value) => patch('ai', { assistantEnabled: value })} label="AI assistant" />
          <Switch checked={ai.coachingEnabled !== false} onChange={(value) => patch('ai', { coachingEnabled: value })} label="Coaching scores" />
          <Switch checked={ai.followUpSuggestionsEnabled !== false} onChange={(value) => patch('ai', { followUpSuggestionsEnabled: value })} label="Follow-up suggestions" />
          <Switch checked={transcription.enabled !== false} onChange={(value) => patch('transcription', { enabled: value })} label="Transcription" />
        </div>
      </Card>

      <Card title="CRM update policy" subtitle="The most consequential AI setting in the product">
        <div className="pill-tabs" style={{ alignSelf: 'flex-start' }}>
          <button type="button" className={approval.mode !== 'auto' ? 'active' : ''} onClick={() => patch('crmApproval', { mode: 'suggest' })}>
            AI suggestion → human approval
          </button>
          <button
            type="button"
            className={approval.mode === 'auto' ? 'active' : ''}
            onClick={() => patch('crmApproval', { mode: 'auto' })}
            disabled={user?.role !== 'super_admin'}
            title={user?.role !== 'super_admin' ? 'Only a super admin can enable automatic updates' : undefined}
          >
            Automatic update
          </button>
        </div>
        <div className="grid grid-2">
          <div className="col-tight">
            <TextField
              label="Auto-apply confidence threshold"
              type="number"
              min="0.5"
              max="1"
              step="0.05"
              defaultValue={approval.autoApplyConfidenceThreshold ?? 0.85}
              onBlur={(event) => patch('crmApproval', { autoApplyConfidenceThreshold: Number(event.target.value) })}
              hint="Only used in automatic mode"
            />
            <span className="xs muted">Currently {percent((approval.autoApplyConfidenceThreshold ?? 0.85) * 100)}</span>
          </div>
          <div className="col-tight">
            <Switch
              checked={approval.alwaysReviewSensitive !== false}
              onChange={(value) => patch('crmApproval', { alwaysReviewSensitive: value })}
              label="Always review sensitive fields (deal value, stage, close date, email)"
            />
            <Switch
              checked={Boolean(approval.autoCreateTasks)}
              onChange={(value) => patch('crmApproval', { autoCreateTasks: value })}
              label="Create AI follow-up tasks automatically"
            />
          </div>
        </div>
        {approval.mode === 'auto' && approval.alwaysReviewSensitive === false && (
          <div className="banner danger small">
            <IconAlert />
            <span>
              Every extracted field — including deal value and stage — will be written to the CRM without a human
              seeing it first. Changes remain fully audited and reversible, but forecast accuracy now depends on model
              accuracy.
            </span>
          </div>
        )}
      </Card>

      <Card title="Transcription">
        <div className="grid grid-2">
          <Switch checked={transcription.redactPii !== false} onChange={(value) => patch('transcription', { redactPii: value })} label="Redact card, SSN and IBAN patterns before storing" />
          <TextField
            label="Language"
            defaultValue={transcription.language || 'en'}
            onBlur={(event) => patch('transcription', { language: event.target.value })}
          />
        </div>
      </Card>

      {usage.data && (
        <Card title="AI usage (30 days)" flush>
          <DataTable
            columns={[
              { key: 'feature', label: 'Feature', render: (row) => titleCase(row.feature) },
              { key: 'provider', label: 'Provider' },
              { key: 'calls', label: 'Requests', numeric: true, render: (row) => <span className="tabular">{number(row.calls)}</span> },
              { key: 'tokens', label: 'Tokens', numeric: true, render: (row) => <span className="tabular">{number((row.input_tokens || 0) + (row.output_tokens || 0))}</span> },
              { key: 'latency', label: 'Avg latency', numeric: true, render: (row) => <span className="tabular">{row.avg_latency_ms ? `${row.avg_latency_ms} ms` : '--'}</span> },
              { key: 'failures', label: 'Failures', numeric: true, render: (row) => (row.failures ? <Badge tone="danger">{row.failures}</Badge> : '0') },
            ]}
            rows={usage.data.byFeature}
            rowKey={(row) => `${row.feature}-${row.provider}`}
            empty={<EmptyState title="No AI usage yet" />}
          />
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------ call and recording --- */
function CallSettings() {
  const toast = useToast();
  const { settings, updateSettings } = useAuth();
  const meta = useApi('/meta');
  const recording = settings?.recording || {};

  const patch = async (value) => {
    try {
      const result = await api.patch('/admin/settings', { settings: { recording: value } });
      updateSettings(result.settings);
      toast.success('Recording policy updated');
    } catch (error) {
      toast.error(error);
    }
  };

  return (
    <div className="col">
      <Card title="Call recording policy" subtitle="Consent requirements vary by jurisdiction — configure them here">
        <div className="grid grid-2">
          <SelectField
            label="Default consent mode"
            value={recording.consentMode || 'all_party'}
            onChange={(event) => patch({ consentMode: event.target.value })}
            options={[
              { value: 'all_party', label: 'All-party consent (safest)' },
              { value: 'one_party', label: 'One-party consent' },
              { value: 'disabled', label: 'Recording disabled' },
            ]}
          />
          <TextField
            label="Recording retention (days)"
            type="number"
            min="1"
            defaultValue={recording.retentionDays ?? 365}
            onBlur={(event) => patch({ retentionDays: Number(event.target.value) })}
            hint="Recordings are permanently deleted from object storage after this"
          />
        </div>
        <div className="grid grid-2">
          <Switch checked={recording.enabled !== false} onChange={(value) => patch({ enabled: value })} label="Allow call recording" />
          <Switch checked={recording.playAnnouncement !== false} onChange={(value) => patch({ playAnnouncement: value })} label="Announce recording at the start of the call" />
        </div>
        <div className="banner small">
          <IconShield />
          <span>
            In all-party regions the agent must capture consent before recording starts; the call console prompts them
            and the decision is written to the call record and the contact. Overrides below let you match local law per
            region.
          </span>
        </div>
      </Card>

      <Card title="Regional overrides" subtitle="Country or region code to consent mode">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Region</th><th>Consent mode</th></tr></thead>
            <tbody>
              {Object.entries(recording.regionOverrides || {}).map(([region, override]) => (
                <tr key={region}>
                  <td className="mono">{region}</td>
                  <td>
                    <select
                      className="select"
                      style={{ maxWidth: 220 }}
                      value={override.consentMode}
                      onChange={(event) => patch({
                        regionOverrides: { ...recording.regionOverrides, [region]: { consentMode: event.target.value } },
                      })}
                    >
                      <option value="all_party">All-party consent</option>
                      <option value="one_party">One-party consent</option>
                      <option value="disabled">Recording disabled</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form
          className="row-tight"
          onSubmit={(event) => {
            event.preventDefault();
            const region = event.target.region.value.trim().toUpperCase();
            const mode = event.target.mode.value;
            if (!region) return;
            patch({ regionOverrides: { ...recording.regionOverrides, [region]: { consentMode: mode } } });
            event.target.reset();
          }}
        >
          <input name="region" className="input" placeholder="Region code, e.g. US_CA or DE" style={{ maxWidth: 240 }} />
          <select name="mode" className="select" style={{ maxWidth: 200 }}>
            <option value="all_party">All-party consent</option>
            <option value="one_party">One-party consent</option>
            <option value="disabled">Recording disabled</option>
          </select>
          <button type="submit" className="btn">Add override</button>
        </form>
      </Card>

      <Card title="Telephony">
        <KeyValue items={[
          { label: 'Provider', value: <Badge tone="outline">{meta.data?.telephonyProvider || '--'}</Badge> },
          { label: 'Email provider', value: <Badge tone="outline">{meta.data?.emailProvider || '--'}</Badge> },
          { label: 'Supported countries', value: <span className="small">{(meta.data?.supportedCountries || []).join(', ')}</span> },
        ]}
        />
        <span className="xs muted">
          Change the provider with the <span className="mono">TELEPHONY_PROVIDER</span> environment variable, and
          connect credentials under Integrations.
        </span>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------- integrations --- */
function Integrations() {
  const toast = useToast();
  const { data, loading, refetch } = useApi('/admin/integrations');
  const [configuring, setConfiguring] = useState(null);

  const byCategory = (data?.integrations || []).reduce((acc, entry) => {
    acc[entry.category] = acc[entry.category] || [];
    acc[entry.category].push(entry);
    return acc;
  }, {});

  if (loading && !data) return <Spinner />;

  return (
    <div className="col">
      <div className="banner small">
        <IconLink />
        <span>
          Each integration is an adapter behind a stable interface, so email, calendar, telephony and CRM providers can
          be swapped without touching call handling or the CRM. Credentials are encrypted at rest and never returned by
          the API.
        </span>
      </div>

      {Object.entries(byCategory).map(([category, entries]) => (
        <Card key={category} title={titleCase(category)}>
          <div className="grid grid-auto">
            {entries.map((integration) => (
              <div key={integration.provider} className="card" style={{ padding: 'var(--space-3)' }}>
                <div className="between">
                  <strong className="small">{integration.name}</strong>
                  <Badge tone={integration.status === 'connected' ? 'success' : integration.status === 'error' ? 'danger' : 'outline'}>
                    {integration.status}
                  </Badge>
                </div>
                <span className="xs secondary">{integration.description}</span>
                {integration.lastSyncAt && <span className="xs muted">Last sync {relative(integration.lastSyncAt)}</span>}
                {integration.lastError && <span className="xs" style={{ color: 'var(--danger)' }}>{integration.lastError}</span>}
                <div className="row-tight">
                  <button type="button" className="btn sm" onClick={() => setConfiguring(integration)}>
                    {integration.status === 'connected' ? 'Configure' : 'Connect'}
                  </button>
                  {integration.status === 'connected' && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={async () => {
                        await api.del(`/admin/integrations/${integration.provider}`);
                        toast.info(`${integration.name} disconnected`);
                        refetch();
                      }}
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}

      <Drawer
        open={Boolean(configuring)}
        onClose={() => setConfiguring(null)}
        title={configuring?.name || 'Integration'}
        footer={(
          <button
            type="button"
            className="btn primary block"
            onClick={async () => {
              const configText = document.getElementById('integration-config')?.value || '{}';
              const credentialsText = document.getElementById('integration-credentials')?.value || '';
              try {
                await api.post(`/admin/integrations/${configuring.provider}`, {
                  config: JSON.parse(configText || '{}'),
                  credentials: credentialsText ? JSON.parse(credentialsText) : undefined,
                  status: 'connected',
                });
                toast.success(`${configuring.name} connected`);
                setConfiguring(null);
                refetch();
              } catch (error) {
                toast.error(error.message?.includes('JSON') ? 'Configuration must be valid JSON' : error);
              }
            }}
          >
            Save and connect
          </button>
        )}
      >
        {configuring && (
          <div className="col">
            <p className="small secondary">{configuring.description}</p>
            <TextArea
              id="integration-config"
              label="Configuration (JSON)"
              className="mono"
              rows={6}
              defaultValue={JSON.stringify(configuring.config || {}, null, 2)}
            />
            <TextArea
              id="integration-credentials"
              label="Credentials (JSON)"
              className="mono"
              rows={5}
              placeholder='{"accessToken": "…"}'
              hint={configuring.hasCredentials ? 'Credentials are already stored. Leave blank to keep them.' : 'Encrypted with AES-256-GCM before storage.'}
            />
          </div>
        )}
      </Drawer>
    </div>
  );
}

/* --------------------------------------------------------- API + webhooks --- */
function ApiAccess() {
  const toast = useToast();
  const keys = useApi('/admin/api-keys');
  const webhooks = useApi('/admin/webhooks');
  const [newKey, setNewKey] = useState(null);
  const [newSecret, setNewSecret] = useState(null);
  const [webhookForm, setWebhookForm] = useState({ url: '', events: [] });

  const createKey = async () => {
    const name = window.prompt('Name for this API key');
    if (!name) return;
    try {
      const result = await api.post('/admin/api-keys', { name });
      setNewKey(result.key);
      keys.refetch();
    } catch (error) {
      toast.error(error);
    }
  };

  const createWebhook = async (event) => {
    event.preventDefault();
    try {
      const result = await api.post('/admin/webhooks', webhookForm);
      setNewSecret(result.signingSecret);
      setWebhookForm({ url: '', events: [] });
      webhooks.refetch();
    } catch (caught) {
      toast.error(caught);
    }
  };

  return (
    <div className="col">
      <Card
        title="API keys"
        subtitle="Server-to-server access. Keys act with admin authority in this organisation and are recorded separately in the audit log."
        actions={<button type="button" className="btn primary sm" onClick={createKey}><IconPlus /> Create key</button>}
        flush
      >
        <DataTable
          columns={[
            { key: 'name', label: 'Name', render: (key) => <span className="cell-primary">{key.name}</span> },
            { key: 'prefix', label: 'Prefix', render: (key) => <span className="mono small">{key.prefix}…</span> },
            { key: 'created', label: 'Created', render: (key) => <span className="small">{date(key.created_at)}</span> },
            { key: 'used', label: 'Last used', render: (key) => <span className="small">{key.last_used_at ? relative(key.last_used_at) : 'never'}</span> },
            { key: 'status', label: 'Status', render: (key) => <Badge tone={key.revoked_at ? 'danger' : 'success'}>{key.revoked_at ? 'revoked' : 'active'}</Badge> },
            {
              key: 'actions',
              label: '',
              width: 44,
              render: (key) => (!key.revoked_at ? (
                <button
                  type="button"
                  className="btn sm ghost icon"
                  aria-label="Revoke key"
                  onClick={async () => {
                    await api.del(`/admin/api-keys/${key.id}`);
                    toast.info('Key revoked');
                    keys.refetch();
                  }}
                >
                  <IconTrash size={13} />
                </button>
              ) : null),
            },
          ]}
          rows={keys.data?.keys || []}
          empty={<EmptyState title="No API keys" message="Create one to use the REST API from another system." />}
        />
      </Card>

      <div className="grid grid-main">
        <Card title="Webhooks" subtitle="Signed with HMAC-SHA256 over timestamp and body" flush>
          <DataTable
            columns={[
              { key: 'url', label: 'Endpoint', render: (hook) => <span className="mono small truncate">{hook.url}</span> },
              { key: 'events', label: 'Events', render: (hook) => <span className="small">{hook.events.length} subscribed</span> },
              { key: 'status', label: 'Last status', render: (hook) => (hook.last_status ? <Badge tone={hook.last_status < 300 ? 'success' : 'danger'}>{hook.last_status}</Badge> : <span className="muted">--</span>) },
              { key: 'failures', label: 'Failures', numeric: true, render: (hook) => (hook.failure_count ? <Badge tone="warning">{hook.failure_count}</Badge> : '0') },
              { key: 'enabled', label: 'Enabled', render: (hook) => <Badge tone={hook.enabled ? 'success' : 'outline'}>{hook.enabled ? 'yes' : 'no'}</Badge> },
              {
                key: 'actions',
                label: '',
                width: 44,
                render: (hook) => (
                  <button
                    type="button"
                    className="btn sm ghost icon"
                    aria-label="Delete webhook"
                    onClick={async () => {
                      await api.del(`/admin/webhooks/${hook.id}`);
                      toast.info('Webhook deleted');
                      webhooks.refetch();
                    }}
                  >
                    <IconTrash size={13} />
                  </button>
                ),
              },
            ]}
            rows={webhooks.data?.webhooks || []}
            empty={<EmptyState title="No webhooks" />}
          />
        </Card>

        <Card title="New webhook">
          <form className="col" onSubmit={createWebhook}>
            <TextField
              label="Endpoint URL"
              type="url"
              value={webhookForm.url}
              onChange={(event) => setWebhookForm((current) => ({ ...current, url: event.target.value }))}
              placeholder="https://example.com/hooks/salesos"
              required
            />
            <div className="col-tight">
              <span className="small strong">Events</span>
              <div className="col-tight" style={{ maxHeight: 220, overflowY: 'auto' }}>
                {(webhooks.data?.availableEvents || []).map((event) => (
                  <Checkbox
                    key={event}
                    label={event}
                    checked={webhookForm.events.includes(event)}
                    onChange={(checked) => setWebhookForm((current) => ({
                      ...current,
                      events: checked ? [...current.events, event] : current.events.filter((e) => e !== event),
                    }))}
                  />
                ))}
              </div>
            </div>
            <button type="submit" className="btn primary" disabled={!webhookForm.url || !webhookForm.events.length}>
              Create webhook
            </button>
          </form>
        </Card>
      </div>

      {webhooks.data?.recentDeliveries?.length > 0 && (
        <Card title="Recent deliveries" flush>
          <DataTable
            columns={[
              { key: 'event', label: 'Event', render: (row) => <span className="mono small">{row.event}</span> },
              { key: 'status', label: 'Status', render: (row) => <Badge tone={row.status_code && row.status_code < 300 ? 'success' : 'danger'}>{row.status_code || 'error'}</Badge> },
              { key: 'attempt', label: 'Attempt', numeric: true },
              { key: 'error', label: 'Error', render: (row) => <span className="small muted truncate">{row.error || '--'}</span> },
              { key: 'when', label: 'When', render: (row) => <span className="small nowrap">{relative(row.created_at)}</span> },
            ]}
            rows={webhooks.data.recentDeliveries}
          />
        </Card>
      )}

      <Modal open={Boolean(newKey)} onClose={() => setNewKey(null)} title="API key created">
        <div className="banner warning small"><IconAlert /> <span>Copy this now. It is never shown again.</span></div>
        <code className="mono" style={{ display: 'block', padding: 'var(--space-3)', background: 'var(--bg-sunken)', borderRadius: 'var(--radius)', wordBreak: 'break-all' }}>
          {newKey}
        </code>
        <span className="xs muted">Send it as <span className="mono">x-api-key</span> on any API request.</span>
      </Modal>

      <Modal open={Boolean(newSecret)} onClose={() => setNewSecret(null)} title="Webhook signing secret">
        <div className="banner warning small"><IconAlert /> <span>Copy this now. It is never shown again.</span></div>
        <code className="mono" style={{ display: 'block', padding: 'var(--space-3)', background: 'var(--bg-sunken)', borderRadius: 'var(--radius)', wordBreak: 'break-all' }}>
          {newSecret}
        </code>
        <span className="xs muted">
          Verify the <span className="mono">X-SalesOS-Signature</span> header: HMAC-SHA256 of{' '}
          <span className="mono">timestamp + &quot;.&quot; + body</span>.
        </span>
      </Modal>
    </div>
  );
}

/* -------------------------------------------------- security + retention --- */
function Security() {
  const toast = useToast();
  const { settings, updateSettings, user } = useAuth();
  const security = settings?.security || {};
  const retention = settings?.dataRetention || {};
  const notifications = settings?.notifications || {};
  const isSuperAdmin = user?.role === 'super_admin';

  const patch = async (section, value) => {
    try {
      const result = await api.patch('/admin/settings', { settings: { [section]: value } });
      updateSettings(result.settings);
      toast.success('Settings updated');
    } catch (error) {
      toast.error(error);
    }
  };

  return (
    <div className="col">
      <Card title="Security">
        <div className="grid grid-2">
          <TextField
            label="Session timeout (minutes)"
            type="number"
            defaultValue={security.sessionTimeoutMinutes ?? 720}
            onBlur={(event) => patch('security', { sessionTimeoutMinutes: Number(event.target.value) })}
          />
          <TextField
            label="Minimum password length"
            type="number"
            min="8"
            defaultValue={security.passwordMinLength ?? 10}
            onBlur={(event) => patch('security', { passwordMinLength: Number(event.target.value) })}
          />
        </div>
        <Switch
          checked={Boolean(security.requireMfaForAdmins)}
          onChange={(value) => patch('security', { requireMfaForAdmins: value })}
          label="Require multi-factor authentication for admin roles"
        />
        <TextField
          label="IP allowlist"
          defaultValue={(security.ipAllowlist || []).join(', ')}
          onBlur={(event) => patch('security', {
            ipAllowlist: event.target.value.split(',').map((s) => s.trim()).filter(Boolean),
          })}
          hint="Comma separated CIDR ranges. Empty means no restriction."
        />
        <div className="banner small">
          <IconShield />
          <span>
            Passwords are stored as scrypt hashes, refresh tokens are rotated on every use, integration credentials are
            AES-256-GCM encrypted, and recordings can be encrypted at rest. Every organisation&apos;s data is isolated by
            the authenticated token — no request can reach another tenant&apos;s records.
          </span>
        </div>
      </Card>

      <Card title="Data retention" subtitle={isSuperAdmin ? 'Deletions are permanent and audited' : 'Only a super admin can change retention'}>
        <div className="grid grid-4">
          {[
            { key: 'recordingDays', label: 'Recordings (days)' },
            { key: 'transcriptDays', label: 'Transcripts (days)' },
            { key: 'activityDays', label: 'Activity (days)' },
            { key: 'auditLogDays', label: 'Audit log (days)' },
          ].map((field) => (
            <TextField
              key={field.key}
              label={field.label}
              type="number"
              min="1"
              disabled={!isSuperAdmin}
              defaultValue={retention[field.key] ?? ''}
              onBlur={(event) => isSuperAdmin && patch('dataRetention', { [field.key]: Number(event.target.value) })}
            />
          ))}
        </div>
        <span className="xs muted">
          A scheduled sweep removes anything past its window and deletes recording objects from storage, writing an
          audit entry for each deletion.
        </span>
      </Card>

      <Card title="Notifications">
        <div className="grid grid-2">
          <Switch checked={notifications.emailReminders !== false} onChange={(value) => patch('notifications', { emailReminders: value })} label="Email task and meeting reminders" />
          <Switch checked={notifications.dailyDigest !== false} onChange={(value) => patch('notifications', { dailyDigest: value })} label="Daily digest for agents" />
          <Switch checked={notifications.managerAlerts !== false} onChange={(value) => patch('notifications', { managerAlerts: value })} label="Manager alerts (overdue work, at-risk deals)" />
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------- audit log --- */
function AuditLog() {
  const [filters, setFilters] = useState({ action: '', actorType: '', entityType: '' });
  const { data, loading, error, refetch } = useApi('/admin/audit', { ...filters, limit: 200 });

  return (
    <Card
      title="Audit log"
      subtitle={data ? `${number(data.total)} recorded events` : 'Loading'}
      actions={<button type="button" className="btn sm ghost icon" onClick={refetch} aria-label="Refresh"><IconRefresh /></button>}
      flush
    >
      <div className="row gap-2 wrap card-body-pad" style={{ paddingBottom: 0 }}>
        <input
          className="input"
          style={{ maxWidth: 220 }}
          placeholder="Action prefix, e.g. lead."
          value={filters.action}
          onChange={(event) => setFilters((current) => ({ ...current, action: event.target.value }))}
        />
        <select className="select" style={{ maxWidth: 180 }} value={filters.actorType} onChange={(event) => setFilters((c) => ({ ...c, actorType: event.target.value }))}>
          <option value="">Any actor</option>
          <option value="user">User</option>
          <option value="ai">AI</option>
          <option value="system">System</option>
        </select>
        <select className="select" style={{ maxWidth: 180 }} value={filters.entityType} onChange={(event) => setFilters((c) => ({ ...c, entityType: event.target.value }))}>
          <option value="">Any entity</option>
          {['lead', 'deal', 'call', 'user', 'organization', 'email', 'task', 'integration', 'api_key', 'webhook'].map((value) => (
            <option key={value} value={value}>{titleCase(value)}</option>
          ))}
        </select>
      </div>

      {loading && !data ? <div className="card-body-pad"><Spinner /></div> : error ? (
        <div className="card-body-pad"><ErrorState error={error} onRetry={refetch} /></div>
      ) : (
        <DataTable
          columns={[
            { key: 'when', label: 'When', render: (row) => <span className="small nowrap" title={row.created_at}>{dateTime(row.created_at)}</span> },
            {
              key: 'actor',
              label: 'Actor',
              render: (row) => (
                <div className="col-tight" style={{ gap: 0 }}>
                  <Badge tone={row.actor_type === 'ai' ? 'accent' : row.actor_type === 'system' ? 'purple' : 'outline'}>{row.actor_type}</Badge>
                  {row.actor_label && <span className="cell-sub truncate">{row.actor_label}</span>}
                </div>
              ),
            },
            { key: 'action', label: 'Action', render: (row) => <span className="mono small">{row.action}</span> },
            {
              key: 'entity',
              label: 'Entity',
              render: (row) => (
                <div className="col-tight" style={{ gap: 0 }}>
                  <span className="small">{row.entity_type ? titleCase(row.entity_type) : '--'}</span>
                  {row.entity_id && <span className="cell-sub mono truncate">{row.entity_id}</span>}
                </div>
              ),
            },
            {
              key: 'diff',
              label: 'Change',
              render: (row) => {
                if (!row.diff) return <span className="muted small">--</span>;
                const entries = Object.entries(row.diff).filter(([key]) => key !== 'updated_at').slice(0, 3);
                return (
                  <div className="col-tight" style={{ gap: 1 }}>
                    {entries.map(([field, change]) => (
                      <span key={field} className="xs">
                        <span className="muted">{titleCase(field)}:</span>{' '}
                        <span className="suggestion-old">{String(change.from ?? 'not set').slice(0, 30)}</span>
                        {' → '}
                        <strong>{String(change.to ?? 'not set').slice(0, 30)}</strong>
                      </span>
                    ))}
                  </div>
                );
              },
            },
            { key: 'source', label: 'Source', render: (row) => <span className="small muted">{row.source}</span> },
          ]}
          rows={data?.audit || []}
          rowKey={(row) => row.id}
          empty={<EmptyState title="No audit entries match" />}
        />
      )}
    </Card>
  );
}

/* --------------------------------------------------------------- system --- */
function System() {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/admin/system');

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;

  return (
    <div className="col">
      <div className="grid grid-4">
        <Stat label="Leads" value={number(data.counts.leads)} />
        <Stat label="Deals" value={number(data.counts.deals)} />
        <Stat label="Calls" value={number(data.counts.calls)} />
        <Stat label="Transcripts" value={number(data.counts.transcripts)} />
      </div>

      <Card
        title="Background queue"
        subtitle={`${data.queue.handlers.length} registered job types · concurrency ${data.queue.concurrency}`}
        actions={(
          <>
            <button
              type="button"
              className="btn sm"
              onClick={async () => {
                const result = await api.post('/admin/reindex');
                toast.success(`Search index rebuilt (${result.indexed} records)`);
              }}
            >
              Rebuild search index
            </button>
            <button type="button" className="btn sm ghost icon" onClick={refetch} aria-label="Refresh"><IconRefresh /></button>
          </>
        )}
      >
        <div className="row gap-4 wrap">
          {Object.entries(data.queue.byStatus).map(([status, count]) => (
            <Stat
              key={status}
              label={titleCase(status)}
              value={number(count)}
              accent={status === 'failed' || status === 'dead' ? 'var(--danger)' : status === 'running' ? 'var(--accent)' : undefined}
            />
          ))}
          <Stat label="Realtime connections" value={number(data.realtimeConnections)} />
        </div>
        <div className="tag-list">
          {data.queue.handlers.map((handler) => <span key={handler} className="chip mono">{handler}</span>)}
        </div>
      </Card>

      <Card title="Recent jobs" flush>
        <DataTable
          columns={[
            { key: 'type', label: 'Type', render: (job) => <span className="mono small">{job.type}</span> },
            {
              key: 'status',
              label: 'Status',
              render: (job) => (
                <Badge tone={job.status === 'succeeded' ? 'success' : job.status === 'failed' || job.status === 'dead' ? 'danger' : job.status === 'running' ? 'accent' : 'outline'}>
                  {job.status}
                </Badge>
              ),
            },
            { key: 'attempts', label: 'Attempts', numeric: true, render: (job) => <span className="tabular">{job.attempts}/{job.max_attempts}</span> },
            { key: 'error', label: 'Last error', render: (job) => <span className="small muted truncate" title={job.last_error}>{job.last_error || '--'}</span> },
            { key: 'created', label: 'Created', render: (job) => <span className="small nowrap">{relative(job.created_at)}</span> },
            {
              key: 'actions',
              label: '',
              width: 44,
              render: (job) => (['failed', 'dead'].includes(job.status) ? (
                <button
                  type="button"
                  className="btn sm ghost icon"
                  aria-label="Retry job"
                  onClick={async () => {
                    await api.post(`/admin/jobs/${job.id}/retry`);
                    toast.success('Job requeued');
                    refetch();
                  }}
                >
                  <IconRefresh size={13} />
                </button>
              ) : null),
            },
          ]}
          rows={data.jobs}
          empty={<EmptyState title="No jobs recorded" />}
        />
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- billing --- */
function Billing() {
  const { data, loading, error } = useApi('/admin/billing');
  const settings = useApi('/admin/settings');

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState error={error} />;

  return (
    <div className="col">
      <div className="grid grid-4">
        <Stat label="Plan" value={titleCase(data.plan)} meta={`${money(data.seatPrice, data.currency)} per seat`} />
        <Stat label="Seats" value={`${data.seatsUsed} / ${data.seats}`} meta="in use" />
        <Stat label="Monthly subscription" value={money(data.monthlySubscription, data.currency)} />
        <Stat
          label="Payments"
          value={titleCase(data.integration)}
          accent={data.integration === 'connected' ? 'var(--success)' : undefined}
        />
      </div>

      <Card title="Usage this period" subtitle={`Since ${date(data.period.since)}`}>
        <div className="grid grid-4">
          <Stat label="Calls" value={number(data.usage.calls)} />
          <Stat label="Transcription minutes" value={number(data.usage.transcriptionMinutes)} />
          <Stat label="AI requests" value={number(data.usage.aiRequests)} />
          <Stat label="AI tokens" value={number(data.usage.aiTokens)} />
        </div>
      </Card>

      {settings.data && (
        <Card title="Organisation">
          <KeyValue items={[
            { label: 'Name', value: settings.data.organization.name },
            { label: 'Slug', value: <span className="mono">{settings.data.organization.slug}</span> },
            { label: 'Plan', value: titleCase(settings.data.organization.plan) },
            { label: 'Currency', value: settings.data.organization.currency },
            { label: 'Timezone', value: settings.data.organization.timezone },
          ]}
          />
        </Card>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- shell --- */
export default function Admin() {
  const location = useLocation();
  const { user } = useAuth();

  return (
    <>
      <PageHeader
        title="Administration"
        subtitle={`${user?.roleLabel} · full change history is kept for everything on this screen`}
      />

      <div className="row wrap gap-2" style={{ overflowX: 'auto' }}>
        {SECTIONS.map((section) => (
          <NavLink
            key={section.to}
            to={section.to}
            className={({ isActive }) => `btn sm ${isActive ? 'primary' : ''}`}
          >
            {section.icon} {section.label}
          </NavLink>
        ))}
      </div>

      <Routes>
        <Route index element={<Navigate to="users" replace />} />
        <Route path="users" element={<Users />} />
        <Route path="teams" element={<Teams />} />
        <Route path="fields" element={<CustomFields />} />
        <Route path="assignment" element={<Assignment />} />
        <Route path="ai" element={<AiSettings />} />
        <Route path="calls" element={<CallSettings />} />
        <Route path="integrations" element={<Integrations />} />
        <Route path="api" element={<ApiAccess />} />
        <Route path="security" element={<Security />} />
        <Route path="audit" element={<AuditLog />} />
        <Route path="system" element={<System />} />
        <Route path="billing" element={<Billing />} />
      </Routes>
    </>
  );
}
