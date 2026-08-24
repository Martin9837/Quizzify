import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import api from '../lib/api.js';
import { useApi, useDebounced } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import {
  PageHeader, Card, Badge, DataTable, SearchBox, SelectField, TextField, TextArea,
  Modal, Drawer, EmptyState, ErrorState, Spinner, useToast, Avatar, Tabs,
} from '../components/UI.jsx';
import {
  IconPlus, IconPhone, IconUpload, IconFilter, IconDownload, IconUsers,
  IconSparkles, IconMail, IconAlert, IconCheck,
} from '../components/Icons.jsx';
import { money, relative, titleCase, number, phone as formatPhone } from '../lib/format.js';

/**
 * Lead list: filtering, sorting, bulk actions, CSV import and duplicate-aware
 * creation. The table is the agent's working surface, so it stays dense and
 * every row is one click from a call.
 */

const EMPTY_LEAD = {
  firstName: '', lastName: '', companyName: '', jobTitle: '', phone: '', email: '',
  location: '', country: 'US', source: 'outbound', industry: '', temperature: 'cold',
  dealValue: '', tags: '', createDeal: false,
};

function LeadForm({ open, onClose, onCreated, facets }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY_LEAD);
  const [duplicate, setDuplicate] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setForm(EMPTY_LEAD);
      setDuplicate(null);
      setError(null);
    }
  }, [open]);

  const set = (key) => (event) => {
    const value = event?.target?.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
  };

  // Duplicate check runs as the identifying fields are filled, so the agent
  // learns about the clash before they finish typing.
  const identity = `${form.email}|${form.phone}|${form.firstName}|${form.companyName}`;
  const debouncedIdentity = useDebounced(identity, 500);
  useEffect(() => {
    if (!open) return;
    if (!form.email && !form.phone) {
      setDuplicate(null);
      return;
    }
    api.post('/leads/check-duplicate', {
      email: form.email || undefined,
      phone: form.phone || undefined,
      firstName: form.firstName || undefined,
      lastName: form.lastName || undefined,
      companyName: form.companyName || undefined,
    }).then((result) => setDuplicate(result.duplicate)).catch(() => setDuplicate(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedIdentity, open]);

  const submit = async (event) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const payload = {
        ...form,
        dealValue: form.dealValue ? Number(form.dealValue) : 0,
        tags: form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      };
      const result = await api.post('/leads', payload);
      toast.success(`${result.lead.name} added${result.assignment ? ` and assigned via "${result.assignment.ruleName}"` : ''}`);
      onCreated?.(result.lead);
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add lead"
      size="wide"
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="lead-form" className="btn primary" disabled={pending}>
            {pending ? <Spinner /> : <IconPlus />} Create lead
          </button>
        </>
      )}
    >
      <form id="lead-form" className="col" onSubmit={submit}>
        {duplicate && (
          <div className="banner warning">
            <IconAlert />
            <div className="grow small">
              <strong>Possible duplicate.</strong>{' '}
              <Link to={`/leads/${duplicate.id}`}>{duplicate.name}</Link>{' '}
              at {duplicate.companyName || 'unknown company'} already exists.
            </div>
          </div>
        )}
        {error && <ErrorState error={error} />}

        <div className="grid grid-2">
          <TextField label="First name" value={form.firstName} onChange={set('firstName')} required autoFocus />
          <TextField label="Last name" value={form.lastName} onChange={set('lastName')} />
          <TextField label="Company" value={form.companyName} onChange={set('companyName')} />
          <TextField label="Job title" value={form.jobTitle} onChange={set('jobTitle')} />
          <TextField label="Phone" value={form.phone} onChange={set('phone')} placeholder="+1 555 010 1234" />
          <TextField label="Email" type="email" value={form.email} onChange={set('email')} />
          <TextField label="Location" value={form.location} onChange={set('location')} placeholder="City, Country" />
          <TextField label="Country code" value={form.country} onChange={set('country')} maxLength={2} hint="ISO code used for phone normalisation" />
          <SelectField
            label="Lead source"
            value={form.source}
            onChange={set('source')}
            options={(facets?.options?.sources || []).map((s) => ({ value: s, label: titleCase(s) }))}
          />
          <TextField label="Industry" value={form.industry} onChange={set('industry')} />
          <SelectField
            label="Temperature"
            value={form.temperature}
            onChange={set('temperature')}
            options={(facets?.options?.temperatures || ['hot', 'warm', 'cold']).map((t) => ({ value: t, label: titleCase(t) }))}
          />
          <TextField label="Deal value" type="number" min="0" value={form.dealValue} onChange={set('dealValue')} hint="Creates an opportunity when set" />
        </div>
        <TextField label="Tags" value={form.tags} onChange={set('tags')} hint="Comma separated" />
      </form>
    </Modal>
  );
}

function ImportDrawer({ open, onClose, onImported }) {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);

  const readFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setResult(null);
    try {
      setPreview(await api.post('/leads/import/preview', { csv: text }));
    } catch (error) {
      toast.error(error);
    }
  };

  const runImport = async () => {
    setPending(true);
    try {
      const response = await api.post('/leads/import', { csv });
      setResult(response);
      if (response.queued) {
        toast.info(`Importing ${response.rows} rows in the background`);
      } else {
        toast.success(`${response.created} leads created${response.duplicates ? `, ${response.duplicates} duplicates skipped` : ''}`);
        onImported?.();
      }
    } catch (error) {
      toast.error(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Import leads"
      wide
      footer={(
        <div className="row-tight">
          <button type="button" className="btn primary grow" onClick={runImport} disabled={!csv || pending}>
            {pending ? <Spinner /> : <IconUpload />}
            Import {preview ? `${preview.totalRows} rows` : ''}
          </button>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
      )}
    >
      <div className="col">
        <p className="small secondary">
          Upload a CSV or paste rows below. Headers are matched loosely -- "Company", "Organisation" and
          "Account" all map to the company field, and anything unrecognised is kept as a custom field.
        </p>

        <label className="btn" style={{ justifyContent: 'center' }}>
          <IconUpload /> Choose CSV or Excel-exported file
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            style={{ display: 'none' }}
            onChange={(event) => readFile(event.target.files?.[0])}
          />
        </label>

        <TextArea
          label="Or paste CSV"
          value={csv}
          onChange={(event) => {
            setCsv(event.target.value);
            setPreview(null);
          }}
          className="mono"
          rows={6}
          placeholder="name,company,email,phone,source&#10;Dana Whitfield,Northwind,dana@northwind.com,+1 555 0101,referral"
        />

        {preview && (
          <Card title={`Preview: ${preview.totalRows} rows`} subtitle={`${preview.headers.length} columns detected`}>
            {preview.duplicatesWithinFile > 0 && (
              <div className="banner warning small">
                <IconAlert /> {preview.duplicatesWithinFile} duplicate rows within the file itself
              </div>
            )}
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Row</th><th>Name</th><th>Company</th><th>Email</th><th>Phone</th><th>Issues</th></tr>
                </thead>
                <tbody>
                  {preview.sample.map((row) => (
                    <tr key={row.row}>
                      <td className="muted">{row.row}</td>
                      <td>{[row.normalised.firstName, row.normalised.lastName].filter(Boolean).join(' ') || '--'}</td>
                      <td className="truncate">{row.normalised.companyName || '--'}</td>
                      <td className="truncate">{row.normalised.email || '--'}</td>
                      <td className="nowrap">{row.normalised.phone || '--'}</td>
                      <td>
                        {row.problems.length
                          ? <Badge tone="danger">{row.problems.join(', ')}</Badge>
                          : <Badge tone="success"><IconCheck size={10} /> ok</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {result && !result.queued && (
          <Card title="Import result">
            <div className="row gap-4">
              <div><span className="stat-value sm">{result.created}</span><div className="small muted">created</div></div>
              <div><span className="stat-value sm">{result.duplicates}</span><div className="small muted">duplicates</div></div>
              <div><span className="stat-value sm">{result.errors.length}</span><div className="small muted">rejected</div></div>
            </div>
            {result.errors.length > 0 && (
              <ul className="list-bullets small">
                {result.errors.slice(0, 10).map((entry, index) => (
                  <li key={index}>Row {entry.row}: {entry.reason}{entry.duplicateOf ? ` (matches existing lead)` : ''}</li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </Drawer>
  );
}

export default function Leads() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const { startCall } = useOutletContext();
  const [searchParams, setSearchParams] = useSearchParams();

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);
  const [filters, setFilters] = useState({ status: '', temperature: '', source: '', ownerId: '' });
  const [sort, setSort] = useState('-updated_at');
  const [selected, setSelected] = useState([]);
  const [showForm, setShowForm] = useState(searchParams.get('new') === '1');
  const [showImport, setShowImport] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [bulkOwner, setBulkOwner] = useState('');

  const presetQuery = useMemo(() => {
    const preset = {};
    if (searchParams.get('notContacted') === '1') preset.notContactedSince = new Date().toISOString();
    if (searchParams.get('followUp') === '1') preset.followUpBefore = new Date(Date.now() + 86400000).toISOString();
    if (searchParams.get('temperature')) preset.temperature = searchParams.get('temperature');
    return preset;
  }, [searchParams]);

  const query = {
    q: debouncedSearch || undefined,
    sort,
    limit: 100,
    ...filters,
    ...presetQuery,
  };
  const { data, loading, error, refetch } = useApi('/leads', query);
  const facets = useApi('/leads/facets');
  const users = useApi('/admin/users', undefined, { enabled: can('user:read') });

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setShowForm(true);
      searchParams.delete('new');
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bulk = async (action, extra = {}) => {
    if (!selected.length) return;
    try {
      await api.post('/leads/bulk', { leadIds: selected, action, ...extra });
      toast.success(`${selected.length} lead${selected.length === 1 ? '' : 's'} updated`);
      setSelected([]);
      refetch();
    } catch (caught) {
      toast.error(caught);
    }
  };

  const exportCsv = () => {
    const rows = data?.leads || [];
    const headers = ['name', 'company', 'title', 'email', 'phone', 'status', 'temperature', 'score', 'source', 'owner', 'dealValue', 'lastContacted'];
    const csv = [
      headers.join(','),
      ...rows.map((lead) => [
        lead.name, lead.companyName, lead.jobTitle, lead.email, lead.phone, lead.status,
        lead.temperature, lead.score, lead.source, lead.ownerName, lead.dealValue, lead.lastContactedAt,
      ].map((value) => {
        const text = value === null || value === undefined ? '' : String(value);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      }).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const columns = [
    {
      key: 'name',
      label: 'Contact',
      sortKey: 'first_name',
      render: (lead) => (
        <div className="row-tight">
          <Avatar name={lead.name} size="sm" />
          <div className="col-tight" style={{ gap: 0, minWidth: 0 }}>
            <span className="cell-primary truncate">{lead.name}</span>
            <span className="cell-sub truncate">{lead.jobTitle || '--'}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'company',
      label: 'Company',
      sortKey: 'company_name',
      render: (lead) => (
        <div className="col-tight" style={{ gap: 0, minWidth: 0 }}>
          <span className="truncate">{lead.companyName || '--'}</span>
          <span className="cell-sub truncate">{lead.location || lead.industry || ''}</span>
        </div>
      ),
    },
    { key: 'status', label: 'Status', render: (lead) => <Badge tone="outline">{titleCase(lead.status)}</Badge> },
    { key: 'temperature', label: 'Temp', render: (lead) => <Badge tone={lead.temperature}>{lead.temperature}</Badge> },
    {
      key: 'score',
      label: 'Score',
      numeric: true,
      sortKey: 'score',
      render: (lead) => <span className="tabular strong">{lead.score}</span>,
    },
    {
      key: 'deal',
      label: 'Deal',
      numeric: true,
      sortKey: 'deal_value',
      render: (lead) => (lead.deal
        ? <span className="tabular">{money(lead.deal.value, undefined, { compact: true })}</span>
        : lead.dealValue ? <span className="tabular muted">{money(lead.dealValue, undefined, { compact: true })}</span> : <span className="muted">--</span>),
    },
    { key: 'owner', label: 'Owner', render: (lead) => (lead.ownerName ? <span className="row-tight small"><Avatar name={lead.ownerName} size="sm" />{lead.ownerName.split(' ')[0]}</span> : <span className="muted">Unassigned</span>) },
    {
      key: 'lastContacted',
      label: 'Last contact',
      sortKey: 'last_contacted_at',
      render: (lead) => <span className="small nowrap">{lead.lastContactedAt ? relative(lead.lastContactedAt) : <span className="muted">never</span>}</span>,
    },
    {
      key: 'actions',
      label: '',
      width: 96,
      render: (lead) => (
        <div className="row-tight">
          <button
            type="button"
            className="btn sm ghost icon"
            title={`Call ${lead.name}`}
            aria-label={`Call ${lead.name}`}
            disabled={lead.doNotCall || !lead.phone}
            onClick={() => startCall({ leadId: lead.id })}
          >
            <IconPhone size={14} />
          </button>
          <Link to={`/leads/${lead.id}`} className="btn sm ghost icon" title="Open record" aria-label={`Open ${lead.name}`}>
            <IconUsers size={14} />
          </Link>
        </div>
      ),
    },
  ];

  const activeFilterCount = Object.values(filters).filter(Boolean).length + Object.keys(presetQuery).length;

  return (
    <>
      <PageHeader
        title="Leads"
        subtitle={data ? `${number(data.total)} leads in your book` : 'Loading'}
        actions={(
          <>
            <button type="button" className={`btn ${activeFilterCount ? 'primary' : ''}`} onClick={() => setShowFilters(true)}>
              <IconFilter /> Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
            </button>
            <button type="button" className="btn" onClick={exportCsv}><IconDownload /> Export</button>
            {can('lead:import') && <button type="button" className="btn" onClick={() => setShowImport(true)}><IconUpload /> Import</button>}
            {can('lead:write') && <button type="button" className="btn primary" onClick={() => setShowForm(true)}><IconPlus /> Add lead</button>}
          </>
        )}
      />

      <Card flush>
        <div className="row gap-2 wrap card-body-pad" style={{ paddingBottom: 0 }}>
          <SearchBox value={search} onChange={setSearch} placeholder="Search name, company, email or phone" />
          <div className="pill-tabs">
            {['', 'hot', 'warm', 'cold'].map((temperature) => (
              <button
                key={temperature || 'all'}
                type="button"
                className={filters.temperature === temperature ? 'active' : ''}
                onClick={() => setFilters((current) => ({ ...current, temperature }))}
              >
                {temperature ? titleCase(temperature) : 'All'}
              </button>
            ))}
          </div>
        </div>

        {selected.length > 0 && (
          <div className="row gap-2 wrap card-body-pad" style={{ paddingBottom: 0 }}>
            <div className="banner small grow row-tight wrap">
              <strong>{selected.length} selected</strong>
              {can('lead:assign') && (
                <>
                  <select
                    className="select"
                    style={{ maxWidth: 200 }}
                    value={bulkOwner}
                    onChange={(event) => setBulkOwner(event.target.value)}
                    aria-label="Reassign to"
                  >
                    <option value="">Reassign to…</option>
                    {(users.data?.users || []).filter((u) => u.status === 'active').map((user) => (
                      <option key={user.id} value={user.id}>{user.name}</option>
                    ))}
                  </select>
                  <button type="button" className="btn sm primary" disabled={!bulkOwner} onClick={() => bulk('assign', { ownerId: bulkOwner })}>
                    Assign
                  </button>
                </>
              )}
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  const tag = window.prompt('Tag to add to the selected leads');
                  if (tag) bulk('tag', { tags: [tag] });
                }}
              >
                Add tag
              </button>
              {can('lead:delete') && (
                <button type="button" className="btn sm ghost" onClick={() => bulk('archive')}>Archive</button>
              )}
              <button type="button" className="btn sm ghost right" onClick={() => setSelected([])}>Clear</button>
            </div>
          </div>
        )}

        {loading && !data ? (
          <div className="card-body-pad"><Spinner label="Loading leads" /></div>
        ) : error ? (
          <div className="card-body-pad"><ErrorState error={error} onRetry={refetch} /></div>
        ) : (
          <DataTable
            columns={columns}
            rows={data?.leads || []}
            selected={selected}
            onSelect={setSelected}
            sort={sort}
            onSort={(key) => setSort((current) => (current === key ? `-${key}` : key))}
            onRowClick={(lead) => navigate(`/leads/${lead.id}`)}
            empty={(
              <EmptyState
                icon={<IconUsers size={20} />}
                title="No leads match"
                message="Try clearing filters, or import your existing list."
                action={can('lead:import') && <button type="button" className="btn primary" onClick={() => setShowImport(true)}><IconUpload /> Import leads</button>}
              />
            )}
          />
        )}
      </Card>

      <LeadForm open={showForm} onClose={() => setShowForm(false)} onCreated={() => refetch()} facets={facets.data} />
      <ImportDrawer open={showImport} onClose={() => setShowImport(false)} onImported={refetch} />

      <Drawer open={showFilters} onClose={() => setShowFilters(false)} title="Filter leads">
        <div className="col">
          <SelectField
            label="Status"
            value={filters.status}
            placeholder="Any status"
            onChange={(event) => setFilters((c) => ({ ...c, status: event.target.value }))}
            options={(facets.data?.status || []).map((entry) => ({ value: entry.value, label: `${titleCase(entry.value)} (${entry.count})` }))}
          />
          <SelectField
            label="Source"
            value={filters.source}
            placeholder="Any source"
            onChange={(event) => setFilters((c) => ({ ...c, source: event.target.value }))}
            options={(facets.data?.source || []).map((entry) => ({ value: entry.value, label: `${titleCase(entry.value)} (${entry.count})` }))}
          />
          {can('user:read') && (
            <SelectField
              label="Owner"
              value={filters.ownerId}
              placeholder="Any owner"
              onChange={(event) => setFilters((c) => ({ ...c, ownerId: event.target.value }))}
              options={(facets.data?.owners || []).filter((o) => o.value).map((entry) => ({ value: entry.value, label: `${entry.label || 'Unassigned'} (${entry.count})` }))}
            />
          )}
          {facets.data?.tags?.length > 0 && (
            <div className="col-tight">
              <span className="small strong">Popular tags</span>
              <div className="tag-list">
                {facets.data.tags.slice(0, 14).map((tag) => (
                  <button
                    key={tag.value}
                    type="button"
                    className="chip"
                    onClick={() => {
                      setSearch(tag.value);
                      setShowFilters(false);
                    }}
                  >
                    {tag.value} <span className="muted">{tag.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => {
              setFilters({ status: '', temperature: '', source: '', ownerId: '' });
              setSearchParams({}, { replace: true });
            }}
          >
            Clear all filters
          </button>
        </div>
      </Drawer>
    </>
  );
}
