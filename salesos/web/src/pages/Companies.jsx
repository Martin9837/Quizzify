import { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import { useApi, useDebounced } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import {
  PageHeader, Card, Badge, DataTable, SearchBox, Modal, Spinner, ErrorState,
  EmptyState, TextField, TextArea, KeyValue, useToast, Stat, Avatar,
} from '../components/UI.jsx';
import { IconBuilding, IconPlus, IconPhone, IconChevronLeft, IconUsers } from '../components/Icons.jsx';
import { money, number, titleCase, relative } from '../lib/format.js';

/** Company (account) view: contacts, deals and combined activity per account. */
export default function Companies() {
  const { companyId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', domain: '', industry: '', size: '', location: '', notes: '' });

  const list = useApi(companyId ? null : '/companies', { q: debounced || undefined, limit: 100 });
  const detail = useApi(companyId ? `/companies/${companyId}` : null);

  if (companyId) {
    if (detail.loading && !detail.data) return <Spinner large label="Loading account" />;
    if (detail.error) return <ErrorState error={detail.error} onRetry={detail.refetch} />;
    const { company, contacts, deals, activity } = detail.data;
    const openDeals = deals.filter((deal) => !['won', 'lost'].includes(deal.stage));

    return (
      <>
        <PageHeader
          title={company.name}
          subtitle={[company.industry, company.size, company.location].filter(Boolean).join(' · ')}
          actions={<Link to="/companies" className="btn"><IconChevronLeft /> All companies</Link>}
        />

        <div className="grid grid-4">
          <Stat label="Contacts" value={number(contacts.length)} icon={<IconUsers />} />
          <Stat label="Open deals" value={number(openDeals.length)} icon={<IconBuilding />} />
          <Stat label="Open pipeline" value={money(openDeals.reduce((sum, deal) => sum + (deal.value || 0), 0), undefined, { compact: true })} />
          <Stat label="Won" value={money(deals.filter((d) => d.stage === 'won').reduce((sum, d) => sum + (d.value || 0), 0), undefined, { compact: true })} accent="var(--success)" />
        </div>

        <div className="grid grid-main">
          <div className="col">
            <Card title="Contacts" flush>
              <DataTable
                columns={[
                  {
                    key: 'name',
                    label: 'Contact',
                    render: (contact) => (
                      <div className="row-tight">
                        <Avatar name={`${contact.first_name} ${contact.last_name || ''}`} size="sm" />
                        <div className="col-tight" style={{ gap: 0 }}>
                          <Link to={`/leads/${contact.id}`} className="cell-primary">{contact.first_name} {contact.last_name}</Link>
                          <span className="cell-sub">{contact.job_title || '--'}</span>
                        </div>
                      </div>
                    ),
                  },
                  { key: 'status', label: 'Status', render: (contact) => <Badge tone="outline">{titleCase(contact.status)}</Badge> },
                  { key: 'temperature', label: 'Temp', render: (contact) => <Badge tone={contact.temperature}>{contact.temperature}</Badge> },
                  { key: 'owner', label: 'Owner', render: (contact) => <span className="small">{contact.owner_name || 'Unassigned'}</span> },
                  {
                    key: 'call',
                    label: '',
                    width: 44,
                    render: (contact) => (
                      <button
                        type="button"
                        className="btn sm ghost icon"
                        aria-label={`Call ${contact.first_name}`}
                        onClick={() => window.salesos?.startCall({ leadId: contact.id })}
                      >
                        <IconPhone size={13} />
                      </button>
                    ),
                  },
                ]}
                rows={contacts}
                empty={<EmptyState title="No contacts at this account" />}
              />
            </Card>

            <Card title="Deals" flush>
              <DataTable
                columns={[
                  { key: 'name', label: 'Deal', render: (deal) => <Link to={`/pipeline?deal=${deal.id}`} className="cell-primary">{deal.name}</Link> },
                  { key: 'stage', label: 'Stage', render: (deal) => <Badge tone={deal.stage === 'won' ? 'success' : deal.stage === 'lost' ? 'danger' : 'outline'}>{titleCase(deal.stage)}</Badge> },
                  { key: 'value', label: 'Value', numeric: true, render: (deal) => <span className="tabular">{money(deal.value)}</span> },
                  { key: 'owner', label: 'Owner', render: (deal) => <span className="small">{deal.owner_name || '--'}</span> },
                ]}
                rows={deals}
                empty={<EmptyState title="No deals at this account" />}
              />
            </Card>
          </div>

          <div className="col">
            <Card title="Account details">
              <KeyValue items={[
                { label: 'Domain', value: company.domain ? <a href={`https://${company.domain}`} target="_blank" rel="noreferrer">{company.domain}</a> : null },
                { label: 'Industry', value: company.industry },
                { label: 'Size', value: company.size },
                { label: 'Location', value: company.location },
                { label: 'Annual revenue', value: company.annual_revenue ? money(company.annual_revenue, undefined, { compact: true }) : null },
              ]}
              />
              {company.notes && <p className="small secondary">{company.notes}</p>}
            </Card>

            <Card title="Recent activity">
              {!activity.length ? <EmptyState title="No activity" /> : (
                <div className="col-tight">
                  {activity.slice(0, 12).map((item) => (
                    <div key={item.id} className="between">
                      <span className="small truncate">{item.title}</span>
                      <span className="xs muted nowrap">{relative(item.occurred_at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      </>
    );
  }

  const createCompany = async (event) => {
    event.preventDefault();
    try {
      const result = await api.post('/companies', form);
      toast.success(`${result.company.name} created`);
      setShowForm(false);
      setForm({ name: '', domain: '', industry: '', size: '', location: '', notes: '' });
      list.refetch();
    } catch (error) {
      toast.error(error);
    }
  };

  return (
    <>
      <PageHeader
        title="Companies"
        subtitle="Accounts, their contacts and their pipeline"
        actions={can('company:write') && <button type="button" className="btn primary" onClick={() => setShowForm(true)}><IconPlus /> Add company</button>}
      />

      <Card flush>
        <div className="card-body-pad" style={{ paddingBottom: 0 }}>
          <SearchBox value={search} onChange={setSearch} placeholder="Search company or domain" />
        </div>
        {list.loading && !list.data ? <div className="card-body-pad"><Spinner /></div> : (
          <DataTable
            columns={[
              {
                key: 'name',
                label: 'Company',
                render: (company) => (
                  <div className="col-tight" style={{ gap: 0, minWidth: 0 }}>
                    <span className="cell-primary truncate">{company.name}</span>
                    <span className="cell-sub truncate">{company.domain || company.industry || '--'}</span>
                  </div>
                ),
              },
              { key: 'industry', label: 'Industry', render: (company) => <span className="small">{company.industry || '--'}</span> },
              { key: 'location', label: 'Location', render: (company) => <span className="small">{company.location || '--'}</span> },
              { key: 'contacts', label: 'Contacts', numeric: true, render: (company) => <span className="tabular">{number(company.contact_count)}</span> },
              { key: 'deals', label: 'Open deals', numeric: true, render: (company) => <span className="tabular">{number(company.open_deals)}</span> },
              { key: 'pipeline', label: 'Pipeline', numeric: true, render: (company) => <span className="tabular strong">{money(company.pipeline_value, undefined, { compact: true })}</span> },
            ]}
            rows={list.data?.companies || []}
            onRowClick={(company) => navigate(`/companies/${company.id}`)}
            empty={<EmptyState icon={<IconBuilding size={20} />} title="No companies" message="Companies are created automatically when you add a lead with a company name." />}
          />
        )}
      </Card>

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title="Add company"
        footer={(
          <>
            <button type="button" className="btn" onClick={() => setShowForm(false)}>Cancel</button>
            <button type="submit" form="company-form" className="btn primary" disabled={!form.name}>Create</button>
          </>
        )}
      >
        <form id="company-form" className="col" onSubmit={createCompany}>
          <TextField label="Name" value={form.name} onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))} required autoFocus />
          <div className="grid grid-2">
            <TextField label="Domain" value={form.domain} onChange={(e) => setForm((c) => ({ ...c, domain: e.target.value }))} />
            <TextField label="Industry" value={form.industry} onChange={(e) => setForm((c) => ({ ...c, industry: e.target.value }))} />
            <TextField label="Size" value={form.size} onChange={(e) => setForm((c) => ({ ...c, size: e.target.value }))} placeholder="200-500" />
            <TextField label="Location" value={form.location} onChange={(e) => setForm((c) => ({ ...c, location: e.target.value }))} />
          </div>
          <TextArea label="Notes" value={form.notes} onChange={(e) => setForm((c) => ({ ...c, notes: e.target.value }))} rows={3} />
        </form>
      </Modal>
    </>
  );
}
