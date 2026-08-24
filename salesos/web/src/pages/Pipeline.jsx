import { useEffect, useMemo, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import api from '../lib/api.js';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import {
  PageHeader, Card, Badge, Stat, Drawer, Modal, Spinner, ErrorState, EmptyState,
  TextField, TextArea, SelectField, KeyValue, useToast, Avatar,
} from '../components/UI.jsx';
import { StackedBar } from '../components/Charts.jsx';
import {
  IconPipeline, IconPhone, IconAlert, IconSparkles, IconMail, IconGrid,
  IconChevronRight, IconTrend, IconClock, IconTarget,
} from '../components/Icons.jsx';
import { money, percent, relative, date, titleCase, number } from '../lib/format.js';

/**
 * Visual pipeline.
 *
 * Drag-and-drop uses the native HTML5 API: no dependency, keyboard-accessible
 * fallback via the stage selector on each card, and it degrades to tapping on
 * touch devices. Deal health from the risk engine is rendered on the card border
 * so a stalling deal is visible without opening anything.
 */

function DealCard({ deal, onOpen, onDragStart, onDragEnd, dragging, onMove, stages }) {
  return (
    <article
      className={`deal-card ${deal.risk?.health || ''} ${dragging ? 'dragging' : ''}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', deal.id);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart(deal);
      }}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(deal)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen(deal);
      }}
      tabIndex={0}
      role="button"
      aria-label={`${deal.name}, ${money(deal.value)}, ${deal.stageLabel}`}
    >
      <div className="between">
        <strong className="small truncate">{deal.companyName || deal.name}</strong>
        <span className="tabular small strong">{money(deal.value, deal.currency, { compact: true })}</span>
      </div>
      <span className="xs muted truncate">{deal.name}</span>

      <div className="row-tight wrap xs">
        {deal.temperature && <Badge tone={deal.temperature}>{deal.temperature}</Badge>}
        <Badge tone="outline">{percent(deal.probability)}</Badge>
        {deal.risk?.health === 'at_risk' && <Badge tone="danger"><IconAlert size={10} /> at risk</Badge>}
        {deal.lastSentiment && <Badge tone={deal.lastSentiment}>{deal.lastSentiment}</Badge>}
      </div>

      {deal.risk?.reasons?.length > 0 && (
        <span className="xs muted truncate" title={deal.risk.reasons.join('; ')}>{deal.risk.reasons[0]}</span>
      )}

      <div className="between xs muted">
        <span className="row-tight">
          {deal.ownerName && <Avatar name={deal.ownerName} size="sm" />}
          {deal.callCount > 0 && <span title="Calls">{deal.callCount} calls</span>}
        </span>
        <span>{deal.expectedCloseDate ? date(deal.expectedCloseDate, { year: undefined }) : 'no close date'}</span>
      </div>

      {/* Keyboard/touch alternative to dragging. */}
      <select
        className="select"
        style={{ padding: '3px 22px 3px 6px', fontSize: 'var(--text-xs)' }}
        value={deal.stage}
        aria-label={`Move ${deal.name} to another stage`}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          event.stopPropagation();
          onMove(deal, event.target.value);
        }}
      >
        {stages.map((stage) => <option key={stage.key} value={stage.key}>{stage.label}</option>)}
      </select>
    </article>
  );
}

function DealDrawer({ dealId, onClose, onChanged }) {
  const toast = useToast();
  const { can } = useAuth();
  const { startCall, askAi } = useOutletContext();
  const { data, loading, error, refetch } = useApi(dealId ? `/deals/${dealId}` : null);
  const velocity = useApi(dealId ? `/deals/${dealId}/velocity` : null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});

  useEffect(() => {
    if (data?.deal) {
      setForm({
        name: data.deal.name,
        value: data.deal.value,
        probability: data.deal.probability,
        expectedCloseDate: data.deal.expectedCloseDate ? data.deal.expectedCloseDate.slice(0, 10) : '',
        decisionMaker: data.deal.decisionMaker || '',
        budget: data.deal.budget || '',
        timeline: data.deal.timeline || '',
        product: data.deal.product || '',
        competitors: (data.deal.competitors || []).join(', '),
        painPoints: (data.deal.painPoints || []).join('; '),
        requirements: (data.deal.requirements || []).join('; '),
        lostReason: data.deal.lostReason || '',
      });
    }
  }, [data]);

  const save = async () => {
    try {
      await api.patch(`/deals/${dealId}`, {
        ...form,
        value: Number(form.value) || 0,
        probability: Number(form.probability),
        budget: form.budget ? Number(form.budget) : undefined,
        expectedCloseDate: form.expectedCloseDate ? new Date(form.expectedCloseDate).toISOString() : undefined,
        competitors: form.competitors ? form.competitors.split(',').map((s) => s.trim()).filter(Boolean) : [],
        painPoints: form.painPoints ? form.painPoints.split(';').map((s) => s.trim()).filter(Boolean) : [],
        requirements: form.requirements ? form.requirements.split(';').map((s) => s.trim()).filter(Boolean) : [],
      });
      toast.success('Deal updated');
      setEditing(false);
      refetch();
      onChanged?.();
    } catch (caught) {
      toast.error(caught);
    }
  };

  return (
    <Drawer
      open={Boolean(dealId)}
      onClose={onClose}
      wide
      title={data?.deal?.name || 'Deal'}
      actions={can('deal:write') && (
        <button type="button" className="btn sm" onClick={() => (editing ? save() : setEditing(true))}>
          {editing ? 'Save' : 'Edit'}
        </button>
      )}
    >
      {loading && <Spinner label="Loading deal" />}
      {error && <ErrorState error={error} onRetry={refetch} />}
      {data && (
        <>
          <div className="grid grid-2">
            <Stat label="Value" value={money(data.deal.value, data.deal.currency)} meta={`${percent(data.deal.probability)} probability`} />
            <Stat label="Weighted" value={money(data.deal.weightedValue, data.deal.currency)} meta={data.deal.stageLabel} />
          </div>

          {data.risk && (
            <div className={`banner ${data.risk.health === 'at_risk' ? 'danger' : data.risk.health === 'watch' ? 'warning' : 'success'}`}>
              <IconAlert />
              <div className="grow small">
                <strong>Deal health: {titleCase(data.risk.health)} ({data.risk.riskScore}/100)</strong>
                <ul className="list-bullets xs mt-2">
                  {data.risk.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
                </ul>
                <div className="mt-2"><strong>Recommended:</strong> {data.risk.recommendedAction}</div>
              </div>
            </div>
          )}

          {data.contact && (
            <Card title="Contact">
              <div className="between">
                <div className="row-tight">
                  <Avatar name={data.contact.name} />
                  <div className="col-tight" style={{ gap: 0 }}>
                    <Link to={`/leads/${data.contact.leadId}`} className="strong">{data.contact.name}</Link>
                    <span className="xs muted">{data.contact.company}</span>
                  </div>
                </div>
                <div className="row-tight">
                  <button type="button" className="btn sm primary" onClick={() => startCall({ leadId: data.contact.leadId, dealId })}>
                    <IconPhone size={13} /> Call
                  </button>
                  <Link to={`/leads/${data.contact.leadId}`} className="btn sm">Open</Link>
                </div>
              </div>
            </Card>
          )}

          {editing ? (
            <Card title="Edit deal">
              <div className="grid grid-2">
                <TextField label="Name" value={form.name || ''} onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))} />
                <TextField label="Value" type="number" value={form.value ?? 0} onChange={(e) => setForm((c) => ({ ...c, value: e.target.value }))} />
                <TextField label="Probability %" type="number" min="0" max="100" value={form.probability ?? 0} onChange={(e) => setForm((c) => ({ ...c, probability: e.target.value }))} />
                <TextField label="Expected close" type="date" value={form.expectedCloseDate || ''} onChange={(e) => setForm((c) => ({ ...c, expectedCloseDate: e.target.value }))} />
                <TextField label="Budget" type="number" value={form.budget ?? ''} onChange={(e) => setForm((c) => ({ ...c, budget: e.target.value }))} />
                <TextField label="Timeline" value={form.timeline || ''} onChange={(e) => setForm((c) => ({ ...c, timeline: e.target.value }))} />
                <TextField label="Decision maker" value={form.decisionMaker || ''} onChange={(e) => setForm((c) => ({ ...c, decisionMaker: e.target.value }))} />
                <TextField label="Product" value={form.product || ''} onChange={(e) => setForm((c) => ({ ...c, product: e.target.value }))} />
              </div>
              <TextField label="Competitors" value={form.competitors || ''} onChange={(e) => setForm((c) => ({ ...c, competitors: e.target.value }))} hint="Comma separated" />
              <TextArea label="Pain points" value={form.painPoints || ''} onChange={(e) => setForm((c) => ({ ...c, painPoints: e.target.value }))} rows={2} hint="Separate with semicolons" />
              <TextArea label="Requirements" value={form.requirements || ''} onChange={(e) => setForm((c) => ({ ...c, requirements: e.target.value }))} rows={2} hint="Separate with semicolons" />
              {data.deal.stage === 'lost' && (
                <TextField label="Lost reason" value={form.lostReason || ''} onChange={(e) => setForm((c) => ({ ...c, lostReason: e.target.value }))} />
              )}
            </Card>
          ) : (
            <Card title="Deal intelligence">
              <KeyValue items={[
                { label: 'Stage', value: data.deal.stageLabel },
                { label: 'Expected close', value: data.deal.expectedCloseDate ? date(data.deal.expectedCloseDate) : null },
                { label: 'Owner', value: data.deal.ownerName },
                { label: 'Product', value: data.deal.product },
                { label: 'Budget', value: data.deal.budget ? money(data.deal.budget, data.deal.currency) : null },
                { label: 'Timeline', value: data.deal.timeline },
                { label: 'Decision maker', value: data.deal.decisionMaker },
                { label: 'Competitors', value: data.deal.competitors?.join(', ') },
                { label: 'Pain points', value: data.deal.painPoints?.join('; ') },
                { label: 'Requirements', value: data.deal.requirements?.join('; ') },
                { label: 'Lost reason', value: data.deal.lostReason },
              ]}
              />
            </Card>
          )}

          {data.aiSuggestions?.length > 0 && (
            <div className="banner">
              <IconSparkles />
              <div className="grow small">
                <strong>{data.aiSuggestions.length} AI suggestion{data.aiSuggestions.length === 1 ? '' : 's'} pending on this deal</strong>
                <div><Link to="/approvals">Review in the approvals queue</Link></div>
              </div>
            </div>
          )}

          {velocity.data?.segments?.length > 0 && (
            <Card title="Stage velocity" subtitle={`${velocity.data.totalDays} days in pipeline`}>
              <div className="col-tight">
                {velocity.data.segments.map((segment, index) => (
                  <div key={index} className="between small">
                    <span className="row-tight">
                      {segment.label}
                      {segment.source === 'ai' && <Badge tone="accent">AI moved</Badge>}
                    </span>
                    <span className="tabular muted">{segment.days}d</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {data.calls?.length > 0 && (
            <Card title="Conversations">
              <div className="col-tight">
                {data.calls.slice(0, 5).map((call) => (
                  <div key={call.id} className="col-tight" style={{ gap: 2 }}>
                    <div className="between">
                      <span className="row-tight small">
                        {call.sentiment && <Badge tone={call.sentiment}>{call.sentiment}</Badge>}
                        <Link to={`/conversations/${call.id}`}>Open transcript</Link>
                      </span>
                      <span className="xs muted">{relative(call.started_at)}</span>
                    </div>
                    {call.summary && <span className="xs secondary">{call.summary}</span>}
                  </div>
                ))}
              </div>
            </Card>
          )}

          <button
            type="button"
            className="btn subtle"
            onClick={() => askAi(`What is the risk on the ${data.deal.name} deal and what should I do next?`)}
          >
            <IconSparkles /> Ask AI about this deal
          </button>
        </>
      )}
    </Drawer>
  );
}

export default function Pipeline() {
  const toast = useToast();
  const { can, isManager } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [openDealId, setOpenDealId] = useState(searchParams.get('deal'));
  const [ownerFilter, setOwnerFilter] = useState('');
  const [lostPrompt, setLostPrompt] = useState(null);

  const { data, loading, error, refetch } = useApi('/deals/pipeline', { ownerId: ownerFilter || undefined });
  const users = useApi('/admin/users', undefined, { enabled: isManager });

  useEffect(() => {
    if (openDealId) setSearchParams({ deal: openDealId }, { replace: true });
    else setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDealId]);

  const move = async (deal, stage, lostReason) => {
    if (deal.stage === stage) return;
    try {
      await api.post(`/deals/${deal.id}/move`, { stage, lostReason });
      toast.success(`${deal.companyName || deal.name} moved to ${stage.replace('_', ' ')}`);
      refetch();
    } catch (caught) {
      if (caught.code === 'lost_reason_required') {
        setLostPrompt({ deal, stage });
        return;
      }
      toast.error(caught);
    }
  };

  const stageOptions = useMemo(() => (data?.stages || []).map((stage) => ({ key: stage.key, label: stage.label })), [data]);

  if (loading && !data) return <Spinner large label="Loading pipeline" />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;

  const { stages, totals } = data;
  const openStages = stages.filter((stage) => !stage.terminal);

  return (
    <>
      <PageHeader
        title="Pipeline"
        subtitle={`${number(totals.openDeals)} open deals · ${money(totals.openValue)} · ${money(totals.weightedForecast)} weighted`}
        actions={(
          <>
            {isManager && (
              <select
                className="select"
                style={{ maxWidth: 200 }}
                value={ownerFilter}
                onChange={(event) => setOwnerFilter(event.target.value)}
                aria-label="Filter by owner"
              >
                <option value="">All owners</option>
                {(users.data?.users || []).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
              </select>
            )}
            <Link to="/analytics" className="btn"><IconTrend /> Analytics</Link>
          </>
        )}
      />

      <div className="grid grid-4">
        <Stat label="Open pipeline" value={money(totals.openValue, undefined, { compact: true })} meta={`${totals.openDeals} deals`} icon={<IconPipeline />} />
        <Stat label="Weighted forecast" value={money(totals.weightedForecast, undefined, { compact: true })} meta="probability adjusted" icon={<IconTarget />} />
        <Stat label="Won" value={money(totals.wonValue, undefined, { compact: true })} accent="var(--success)" icon={<IconTrend />} />
        <Stat
          label="Deals at risk"
          value={number(totals.atRisk)}
          accent={totals.atRisk ? 'var(--danger)' : undefined}
          meta={totals.atRisk ? 'Needs attention today' : 'Pipeline healthy'}
          icon={<IconAlert />}
        />
      </div>

      <Card title="Value by stage" flush>
        <div className="card-body-pad">
          <StackedBar segments={openStages.map((stage) => ({ label: stage.label, value: stage.value }))} />
        </div>
      </Card>

      <div className="kanban" role="list">
        {stages.map((stage) => (
          <section
            key={stage.key}
            className={`kanban-col ${dropTarget === stage.key ? 'drop-target' : ''}`}
            role="listitem"
            onDragOver={(event) => {
              event.preventDefault();
              setDropTarget(stage.key);
            }}
            onDragLeave={() => setDropTarget((current) => (current === stage.key ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              setDropTarget(null);
              const dealId = event.dataTransfer.getData('text/plain');
              const deal = stages.flatMap((s) => s.deals).find((d) => d.id === dealId);
              if (deal) move(deal, stage.key);
              setDragging(null);
            }}
          >
            <header className="kanban-col-head">
              <div className="between">
                <strong className="small">{stage.label}</strong>
                <Badge tone="outline">{stage.count}</Badge>
              </div>
              <div className="between xs muted">
                <span className="tabular">{money(stage.value, undefined, { compact: true })}</span>
                {!stage.terminal && <span className="tabular">{money(stage.weightedValue, undefined, { compact: true })} wtd</span>}
              </div>
            </header>
            <div className="kanban-col-body">
              {stage.deals.length === 0 && <span className="xs muted center" style={{ padding: 'var(--space-3)' }}>Drop a deal here</span>}
              {stage.deals.map((deal) => (
                <DealCard
                  key={deal.id}
                  deal={deal}
                  stages={stageOptions}
                  dragging={dragging?.id === deal.id}
                  onDragStart={setDragging}
                  onDragEnd={() => setDragging(null)}
                  onOpen={(selected) => setOpenDealId(selected.id)}
                  onMove={move}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      <DealDrawer dealId={openDealId} onClose={() => setOpenDealId(null)} onChanged={refetch} />

      <Modal
        open={Boolean(lostPrompt)}
        onClose={() => setLostPrompt(null)}
        title="Why was this deal lost?"
        footer={(
          <>
            <button type="button" className="btn" onClick={() => setLostPrompt(null)}>Cancel</button>
            <button
              type="button"
              className="btn danger"
              onClick={async () => {
                const reason = document.getElementById('lost-reason')?.value?.trim();
                if (!reason) return;
                await move(lostPrompt.deal, 'lost', reason);
                setLostPrompt(null);
              }}
            >
              Mark lost
            </button>
          </>
        )}
      >
        <p className="small secondary">
          Loss reasons are what make win/loss analysis useful. One line is enough.
        </p>
        <TextField
          id="lost-reason"
          label="Lost reason"
          placeholder="Price above approved budget"
          autoFocus
        />
      </Modal>
    </>
  );
}
