import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import api from '../lib/api.js';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useRealtimeEvent } from '../lib/realtime.jsx';
import {
  PageHeader, Card, Badge, Tabs, EmptyState, ErrorState, Spinner, Modal, Drawer,
  TextField, TextArea, SelectField, KeyValue, useToast, Avatar, Meter, Confirm,
} from '../components/UI.jsx';
import SuggestionPanel from '../components/SuggestionPanel.jsx';
import { ScoreRing } from '../components/Charts.jsx';
import {
  IconPhone, IconMail, IconCalendar, IconNote, IconSparkles, IconEdit, IconTask,
  IconWave, IconTrash, IconCheck, IconAlert, IconMessage, IconExternal, IconBuilding,
  IconShield, IconClock, IconRobot,
} from '../components/Icons.jsx';
import { money, relative, dateTime, date, titleCase, duration, phone as formatPhone, percent, elapsedFromMinutes } from '../lib/format.js';

/**
 * Lead record: identity, AI snapshot, deals, and one unified timeline of every
 * interaction. Actions that an agent takes from this page (call, email, note,
 * task, follow-up) are all inline -- no context switch.
 */

const TIMELINE_ICONS = {
  call: <IconPhone size={13} />,
  email: <IconMail size={13} />,
  meeting: <IconCalendar size={13} />,
  note: <IconNote size={13} />,
  task: <IconTask size={13} />,
  crm_change: <IconEdit size={13} />,
  ai_insight: <IconSparkles size={13} />,
  stage_change: <IconWave size={13} />,
  lead_created: <IconCheck size={13} />,
  sms: <IconMessage size={13} />,
  whatsapp: <IconMessage size={13} />,
};

function EditLeadModal({ open, onClose, lead, onSaved, canAssign, users }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open && lead) {
      setForm({
        firstName: lead.firstName || '',
        lastName: lead.lastName || '',
        companyName: lead.companyName || '',
        jobTitle: lead.jobTitle || '',
        phone: lead.phone || '',
        email: lead.email || '',
        location: lead.location || '',
        industry: lead.industry || '',
        status: lead.status,
        temperature: lead.temperature,
        score: lead.score,
        source: lead.source || '',
        ownerId: lead.ownerId || '',
        dealValue: lead.dealValue || 0,
        tags: (lead.tags || []).join(', '),
        doNotCall: lead.doNotCall,
        consentRecording: lead.consentRecording,
      });
      setError(null);
    }
  }, [open, lead]);

  const set = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = async (event) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const payload = {
        ...form,
        score: Number(form.score),
        dealValue: Number(form.dealValue) || 0,
        tags: form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      };
      if (!canAssign) delete payload.ownerId;
      await api.patch(`/leads/${lead.id}`, payload);
      toast.success('Lead updated');
      onSaved?.();
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
      title={`Edit ${lead?.name || 'lead'}`}
      size="wide"
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="edit-lead" className="btn primary" disabled={pending}>
            {pending ? <Spinner /> : null} Save changes
          </button>
        </>
      )}
    >
      <form id="edit-lead" className="col" onSubmit={save}>
        {error && <ErrorState error={error} />}
        <div className="grid grid-2">
          <TextField label="First name" value={form.firstName || ''} onChange={set('firstName')} required />
          <TextField label="Last name" value={form.lastName || ''} onChange={set('lastName')} />
          <TextField label="Company" value={form.companyName || ''} onChange={set('companyName')} />
          <TextField label="Job title" value={form.jobTitle || ''} onChange={set('jobTitle')} />
          <TextField label="Phone" value={form.phone || ''} onChange={set('phone')} />
          <TextField label="Email" type="email" value={form.email || ''} onChange={set('email')} />
          <TextField label="Location" value={form.location || ''} onChange={set('location')} />
          <TextField label="Industry" value={form.industry || ''} onChange={set('industry')} />
          <SelectField
            label="Status"
            value={form.status || ''}
            onChange={set('status')}
            options={['new', 'contacted', 'qualified', 'unqualified', 'customer', 'lost'].map((v) => ({ value: v, label: titleCase(v) }))}
          />
          <SelectField
            label="Temperature"
            value={form.temperature || ''}
            onChange={set('temperature')}
            options={['hot', 'warm', 'cold'].map((v) => ({ value: v, label: titleCase(v) }))}
          />
          <TextField label="Lead score" type="number" min="0" max="100" value={form.score ?? 0} onChange={set('score')} />
          <TextField label="Deal value" type="number" min="0" value={form.dealValue ?? 0} onChange={set('dealValue')} />
          {canAssign && (
            <SelectField
              label="Owner"
              value={form.ownerId || ''}
              onChange={set('ownerId')}
              placeholder="Unassigned"
              options={(users || []).map((user) => ({ value: user.id, label: `${user.name} (${user.roleLabel})` }))}
            />
          )}
          <SelectField
            label="Recording consent"
            value={form.consentRecording || 'unknown'}
            onChange={set('consentRecording')}
            options={['granted', 'denied', 'unknown'].map((v) => ({ value: v, label: titleCase(v) }))}
          />
        </div>
        <TextField label="Tags" value={form.tags || ''} onChange={set('tags')} hint="Comma separated" />
        <label className="checkbox">
          <input type="checkbox" checked={Boolean(form.doNotCall)} onChange={set('doNotCall')} />
          <span className="small">Do not call — blocks outbound dialling and messaging for this contact</span>
        </label>
      </form>
    </Modal>
  );
}

function ComposeEmailDrawer({ open, onClose, lead, callId, onSent }) {
  const toast = useToast();
  const [template, setTemplate] = useState('follow_up');
  const [instructions, setInstructions] = useState('');
  const [draft, setDraft] = useState(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [stage, setStage] = useState('compose');
  const [pending, setPending] = useState(false);
  const meta = useApi('/ai/status', undefined, { enabled: open });

  useEffect(() => {
    if (open) {
      setDraft(null);
      setStage('compose');
      setSubject('');
      setBody('');
      setInstructions('');
    }
  }, [open]);

  const generate = async () => {
    setPending(true);
    try {
      const result = await api.post('/ai/email/generate', {
        template, leadId: lead.id, callId: callId || undefined, instructions: instructions || undefined,
      });
      setDraft(result.draft);
      setSubject(result.draft.subject);
      setBody(result.draft.body);
      setStage('edit');
    } catch (error) {
      toast.error(error);
    } finally {
      setPending(false);
    }
  };

  const send = async () => {
    setPending(true);
    try {
      const created = await api.post('/emails', {
        leadId: lead.id,
        callId: callId || undefined,
        to: lead.email,
        subject,
        body,
        template,
        generatedByAi: Boolean(draft),
      });
      await api.post(`/emails/${created.email.id}/send`);
      toast.success('Email queued for delivery and logged to the CRM');
      onSent?.();
      onClose();
    } catch (error) {
      toast.error(error);
    } finally {
      setPending(false);
    }
  };

  const templates = meta.data?.emailTemplates || [];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`Email ${lead?.name || ''}`}
      wide
      footer={(
        <div className="row-tight">
          {stage === 'compose' && (
            <button type="button" className="btn primary grow" onClick={generate} disabled={pending}>
              {pending ? <Spinner /> : <IconSparkles />} Generate with AI
            </button>
          )}
          {stage === 'edit' && (
            <>
              <button type="button" className="btn" onClick={() => setStage('preview')}>Preview</button>
              <button type="button" className="btn primary grow" onClick={send} disabled={pending || !subject || !body}>
                {pending ? <Spinner /> : <IconMail />} Send
              </button>
            </>
          )}
          {stage === 'preview' && (
            <>
              <button type="button" className="btn" onClick={() => setStage('edit')}>Back to edit</button>
              <button type="button" className="btn primary grow" onClick={send} disabled={pending}>
                {pending ? <Spinner /> : <IconMail />} Send
              </button>
            </>
          )}
        </div>
      )}
    >
      {!lead?.email && (
        <div className="banner warning small"><IconAlert /> This contact has no email address on file.</div>
      )}

      <div className="pill-tabs" role="tablist" style={{ alignSelf: 'flex-start' }}>
        {['compose', 'edit', 'preview'].map((step) => (
          <button
            key={step}
            type="button"
            className={stage === step ? 'active' : ''}
            onClick={() => (step === 'compose' || draft) && setStage(step)}
            disabled={step !== 'compose' && !draft}
          >
            {titleCase(step)}
          </button>
        ))}
      </div>

      {stage === 'compose' && (
        <div className="col">
          <SelectField
            label="Email type"
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            options={templates.map((t) => ({ value: t.key, label: t.label }))}
          />
          <p className="small secondary" style={{ margin: 0 }}>
            {templates.find((t) => t.key === template)?.intent}
          </p>
          <TextArea
            label="Extra instructions (optional)"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="Mention the phased rollout option and copy their CFO."
            rows={3}
          />
          <div className="banner small">
            <IconRobot />
            <span>
              The draft uses the last call transcript, the objections raised and the agreed next step for this contact.
            </span>
          </div>
        </div>
      )}

      {stage === 'edit' && (
        <div className="col">
          <TextField label="To" value={lead?.email || ''} readOnly />
          <TextField label="Subject" value={subject} onChange={(event) => setSubject(event.target.value)} />
          <TextArea label="Body" value={body} onChange={(event) => setBody(event.target.value)} rows={14} />
          {draft?.talkingPoints?.length > 0 && (
            <Card title="Why the AI wrote this">
              <ul className="list-bullets small secondary">
                {draft.talkingPoints.map((point, index) => <li key={index}>{point}</li>)}
              </ul>
              <span className="xs muted">Generated by {draft.provider === 'anthropic' ? draft.model : 'the built-in template engine'}</span>
            </Card>
          )}
        </div>
      )}

      {stage === 'preview' && (
        <Card title="Preview">
          <KeyValue items={[
            { label: 'To', value: lead?.email },
            { label: 'Subject', value: subject },
          ]}
          />
          <hr className="divider" />
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>{body}</div>
        </Card>
      )}
    </Drawer>
  );
}

export default function LeadDetail() {
  const { leadId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { can, isManager } = useAuth();
  const { startCall, askAi } = useOutletContext();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState(searchParams.get('tab') || 'timeline');
  const [showEdit, setShowEdit] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [showTask, setShowTask] = useState(false);
  const [showMeeting, setShowMeeting] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [noteBody, setNoteBody] = useState('');

  const { data, loading, error, refetch } = useApi(`/leads/${leadId}`);
  const timeline = useApi(`/leads/${leadId}/timeline`, { limit: 60 });
  const auditTrail = useApi(`/leads/${leadId}/audit`, undefined, { enabled: tab === 'audit' });
  const users = useApi('/admin/users', undefined, { enabled: can('user:read') });

  useRealtimeEvent('activity.created', (payload) => {
    if (payload?.leadId === leadId) {
      refetch();
      timeline.refetch();
    }
  });
  useRealtimeEvent('analysis.ready', () => {
    refetch();
    timeline.refetch();
  });

  useEffect(() => {
    setSearchParams(tab === 'timeline' ? {} : { tab }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  if (loading && !data) return <Spinner large label="Loading record" />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!data) return null;

  const { lead, deals, calls, tasks, emails, meetings, notes, messages, pendingSuggestions } = data;
  const openDeal = deals.find((deal) => !['won', 'lost'].includes(deal.stage)) || deals[0];
  const latestAnalysedCall = calls.find((call) => call.analysisId);

  const addNote = async (event) => {
    event.preventDefault();
    if (!noteBody.trim()) return;
    try {
      await api.post('/notes', { leadId, body: noteBody.trim() });
      setNoteBody('');
      toast.success('Note added');
      refetch();
      timeline.refetch();
    } catch (caught) {
      toast.error(caught);
    }
  };

  const scheduleFollowUp = async () => {
    const value = window.prompt('Follow up on (YYYY-MM-DD)', new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10));
    if (!value) return;
    try {
      await api.post(`/leads/${leadId}/follow-up`, { at: new Date(`${value}T15:00:00Z`).toISOString(), createTask: true });
      toast.success('Follow-up scheduled and task created');
      refetch();
      timeline.refetch();
    } catch (caught) {
      toast.error(caught);
    }
  };

  const tabs = [
    { key: 'timeline', label: 'Timeline', count: timeline.data?.timeline?.length },
    { key: 'conversations', label: 'Conversations', count: calls.length },
    { key: 'deals', label: 'Deals', count: deals.length },
    { key: 'tasks', label: 'Tasks', count: tasks.filter((t) => t.status === 'open').length },
    { key: 'emails', label: 'Emails', count: emails.length },
    { key: 'notes', label: 'Notes', count: notes.length },
    { key: 'audit', label: 'Change history' },
  ];

  return (
    <>
      <PageHeader
        title={lead.name}
        subtitle={[lead.jobTitle, lead.companyName, lead.location].filter(Boolean).join(' · ')}
        actions={(
          <>
            <button
              type="button"
              className="btn primary"
              disabled={lead.doNotCall || !lead.phone}
              title={lead.doNotCall ? 'This contact is on the do-not-call list' : 'Call now'}
              onClick={() => startCall({ leadId: lead.id, dealId: openDeal?.id })}
            >
              <IconPhone /> Call
            </button>
            <button type="button" className="btn" onClick={() => setShowEmail(true)} disabled={!lead.email}>
              <IconMail /> Email
            </button>
            <button type="button" className="btn" onClick={scheduleFollowUp}><IconCalendar /> Follow-up</button>
            <button type="button" className="btn" onClick={() => setShowTask(true)}><IconTask /> Task</button>
            <button type="button" className="btn subtle" onClick={() => askAi(`Summarise my last conversation with ${lead.companyName || lead.name}`)}>
              <IconSparkles /> Ask AI
            </button>
            {can('lead:write') && <button type="button" className="btn ghost icon" onClick={() => setShowEdit(true)} aria-label="Edit lead"><IconEdit /></button>}
            {can('lead:delete') && <button type="button" className="btn ghost icon" onClick={() => setConfirmArchive(true)} aria-label="Archive lead"><IconTrash /></button>}
          </>
        )}
      >
        <div className="row-tight wrap mt-2">
          <Badge tone={lead.temperature}>{lead.temperature}</Badge>
          <Badge tone="outline">{titleCase(lead.status)}</Badge>
          {lead.source && <Badge tone="outline">{titleCase(lead.source)}</Badge>}
          {lead.doNotCall && <Badge tone="danger"><IconShield size={10} /> Do not call</Badge>}
          {lead.consentRecording === 'granted' && <Badge tone="success">Recording consent on file</Badge>}
          {(lead.tags || []).map((tag) => <span key={tag} className="chip">{tag}</span>)}
        </div>
      </PageHeader>

      {pendingSuggestions?.length > 0 && (
        <SuggestionPanel
          suggestions={pendingSuggestions}
          onChange={() => {
            refetch();
            timeline.refetch();
          }}
          sourceSummary={latestAnalysedCall?.summary}
        />
      )}

      <div className="grid grid-main">
        <div className="col">
          <div className="pill-tabs" role="tablist" style={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
            {tabs.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="tab"
                aria-selected={tab === entry.key}
                className={tab === entry.key ? 'active' : ''}
                onClick={() => setTab(entry.key)}
              >
                {entry.label}{entry.count ? <span className="muted"> {entry.count}</span> : null}
              </button>
            ))}
          </div>

          {tab === 'timeline' && (
            <Card title="Activity timeline" subtitle="Calls, emails, meetings, notes, tasks and CRM changes">
              <form className="row-tight" onSubmit={addNote}>
                <input
                  className="input grow"
                  value={noteBody}
                  onChange={(event) => setNoteBody(event.target.value)}
                  placeholder="Add a note…"
                  aria-label="Add a note"
                />
                <button type="submit" className="btn" disabled={!noteBody.trim()}><IconNote /> Add</button>
              </form>
              <hr className="divider" />
              {!timeline.data?.timeline?.length ? (
                <EmptyState icon={<IconWave size={18} />} title="Nothing recorded yet" message="Make a call or send an email to start the history." />
              ) : (
                <div className="timeline">
                  {timeline.data.timeline.map((item) => (
                    <div key={item.id} className="timeline-item">
                      <span className={`timeline-dot ${item.actorType === 'ai' ? 'ai' : item.type}`}>
                        {TIMELINE_ICONS[item.type] || <IconWave size={13} />}
                      </span>
                      <div className="timeline-content col-tight" style={{ gap: 2 }}>
                        <div className="row-tight wrap">
                          <span className="small strong">{item.title}</span>
                          {item.actorType === 'ai' && <Badge tone="accent"><IconSparkles size={10} /> AI</Badge>}
                          <span className="xs muted">{relative(item.occurredAt)}</span>
                        </div>
                        {item.body && <p className="small secondary" style={{ margin: 0 }}>{item.body}</p>}
                        {item.type === 'crm_change' && item.metadata?.field && (
                          <span className="xs muted">
                            {titleCase(item.metadata.field)}: <span className="suggestion-old">{String(item.metadata.from ?? 'not set')}</span>
                            {' → '}<span className="strong">{String(item.metadata.to)}</span>
                            {item.metadata.confidence ? ` · ${percent(item.metadata.confidence * 100)} confidence` : ''}
                          </span>
                        )}
                        {item.type === 'call' && item.metadata?.durationSeconds !== undefined && (
                          <span className="xs muted">
                            {duration(item.metadata.durationSeconds)}
                            {item.metadata.recorded ? ' · recorded' : ''}
                            {item.refId ? <> · <Link to={`/conversations/${item.refId}`}>open conversation</Link></> : null}
                          </span>
                        )}
                        {item.type === 'ai_insight' && item.metadata?.score !== null && item.metadata?.score !== undefined && (
                          <span className="xs muted">
                            Call score {item.metadata.score} · sentiment {item.metadata.sentiment}
                            {item.metadata.suggestions ? ` · ${item.metadata.suggestions} CRM suggestions` : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {tab === 'conversations' && (
            <Card title="Calls and conversations">
              {!calls.length ? (
                <EmptyState icon={<IconPhone size={18} />} title="No calls yet" />
              ) : (
                <div className="col-tight">
                  {calls.map((call) => (
                    <div key={call.id} className="card hover" style={{ padding: 'var(--space-3)' }}>
                      <div className="between">
                        <div className="row-tight">
                          <Badge tone={call.outcome === 'connected' || call.outcome === 'meeting_booked' ? 'success' : 'outline'}>
                            {titleCase(call.outcome || call.status)}
                          </Badge>
                          <span className="small">{titleCase(call.direction)}</span>
                          <span className="small muted">{duration(call.durationSeconds)}</span>
                          {call.hasRecording && <Badge tone="outline">recorded</Badge>}
                          {call.sentiment && <Badge tone={call.sentiment}>{call.sentiment}</Badge>}
                        </div>
                        <span className="xs muted">{dateTime(call.startedAt)}</span>
                      </div>
                      {call.summary && <p className="small secondary" style={{ margin: 0 }}>{call.summary}</p>}
                      {call.notes && <p className="small quote" style={{ margin: 0 }}>{call.notes}</p>}
                      <div className="row-tight">
                        {call.analysisId ? (
                          <Link to={`/conversations/${call.id}`} className="btn sm">
                            <IconSparkles size={13} /> Transcript and analysis
                          </Link>
                        ) : call.aiStatus === 'processing' || call.aiStatus === 'queued' ? (
                          <span className="row-tight xs muted"><Spinner /> AI processing…</span>
                        ) : call.aiStatus === 'failed' ? (
                          <span className="xs danger" title="The recording could not be processed. The call itself is logged.">
                            Recording could not be processed
                          </span>
                        ) : (
                          <span className="xs muted">No transcript for this call</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {tab === 'deals' && (
            <Card
              title="Deals"
              actions={can('deal:write') && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={async () => {
                    const name = window.prompt('Deal name', `${lead.companyName || lead.name} - new opportunity`);
                    if (!name) return;
                    const value = Number(window.prompt('Deal value', '25000') || 0);
                    await api.post('/deals', { leadId, name, value, stage: 'qualified' });
                    toast.success('Deal created');
                    refetch();
                  }}
                >
                  New deal
                </button>
              )}
            >
              {!deals.length ? (
                <EmptyState icon={<IconWave size={18} />} title="No deals" message="Create one to track this opportunity in the pipeline." />
              ) : (
                <div className="col-tight">
                  {deals.map((deal) => (
                    <div key={deal.id} className="card" style={{ padding: 'var(--space-3)' }}>
                      <div className="between">
                        <strong className="truncate">{deal.name}</strong>
                        <Badge tone={deal.stage === 'won' ? 'success' : deal.stage === 'lost' ? 'danger' : 'outline'}>
                          {deal.stageLabel}
                        </Badge>
                      </div>
                      <div className="row gap-4 wrap small">
                        <span><span className="muted">Value</span> <strong className="tabular">{money(deal.value, deal.currency)}</strong></span>
                        <span><span className="muted">Probability</span> <strong>{percent(deal.probability)}</strong></span>
                        <span><span className="muted">Weighted</span> <strong className="tabular">{money(deal.weightedValue, deal.currency)}</strong></span>
                        {deal.expectedCloseDate && <span><span className="muted">Close</span> <strong>{date(deal.expectedCloseDate)}</strong></span>}
                      </div>
                      <KeyValue items={[
                        { label: 'Decision maker', value: deal.decisionMaker },
                        { label: 'Budget', value: deal.budget ? money(deal.budget, deal.currency) : null },
                        { label: 'Timeline', value: deal.timeline },
                        { label: 'Competitors', value: deal.competitors?.length ? deal.competitors.join(', ') : null },
                        { label: 'Pain points', value: deal.painPoints?.length ? deal.painPoints.join('; ') : null },
                        { label: 'Requirements', value: deal.requirements?.length ? deal.requirements.join('; ') : null },
                        { label: 'Lost reason', value: deal.lostReason },
                      ]}
                      />
                      <Link to={`/pipeline?deal=${deal.id}`} className="btn sm ghost" style={{ alignSelf: 'flex-start' }}>
                        Open in pipeline <IconExternal size={12} />
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {tab === 'tasks' && (
            <Card title="Tasks" actions={<button type="button" className="btn sm" onClick={() => setShowTask(true)}>New task</button>}>
              {!tasks.length ? <EmptyState icon={<IconTask size={18} />} title="No tasks" /> : (
                <ul className="list-plain">
                  {tasks.map((task) => (
                    <li key={task.id} className="row gap-2" style={{ alignItems: 'flex-start' }}>
                      <button
                        type="button"
                        className="btn ghost icon sm"
                        aria-label={`Complete ${task.title}`}
                        disabled={task.status === 'done'}
                        onClick={async () => {
                          await api.post(`/tasks/${task.id}/complete`);
                          toast.success('Task completed');
                          refetch();
                        }}
                      >
                        <IconCheck size={14} />
                      </button>
                      <div className="grow col-tight" style={{ gap: 1 }}>
                        <span className={`small ${task.status === 'done' ? 'muted' : 'strong'}`} style={task.status === 'done' ? { textDecoration: 'line-through' } : undefined}>
                          {task.title}
                        </span>
                        <span className="xs muted row-tight wrap">
                          <Badge tone={task.priority === 'urgent' ? 'danger' : 'outline'}>{task.priority}</Badge>
                          {task.source === 'ai' && <Badge tone="accent">AI</Badge>}
                          <span>{task.due_at ? relative(task.due_at) : 'no due date'}</span>
                          {task.assignee_name && <span>· {task.assignee_name}</span>}
                        </span>
                        {task.ai_reason && <span className="xs secondary">{task.ai_reason}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {tab === 'emails' && (
            <Card title="Emails" actions={<button type="button" className="btn sm" onClick={() => setShowEmail(true)} disabled={!lead.email}>Compose</button>}>
              {!emails.length ? <EmptyState icon={<IconMail size={18} />} title="No emails logged" /> : (
                <div className="col-tight">
                  {emails.map((email) => (
                    <div key={email.id} className="between">
                      <div className="col-tight" style={{ gap: 1, minWidth: 0 }}>
                        <span className="small strong truncate">{email.subject}</span>
                        <span className="xs muted row-tight wrap">
                          <Badge tone={email.status === 'sent' ? 'success' : email.status === 'failed' ? 'danger' : 'outline'}>{email.status}</Badge>
                          {email.generated_by_ai ? <Badge tone="accent">AI drafted{email.edited_by_human ? ', edited' : ''}</Badge> : null}
                          {email.template && <span>{titleCase(email.template)}</span>}
                        </span>
                      </div>
                      <span className="xs muted nowrap">{relative(email.sent_at || email.created_at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {tab === 'notes' && (
            <Card title="Notes">
              <form className="row-tight" onSubmit={addNote}>
                <input className="input grow" value={noteBody} onChange={(event) => setNoteBody(event.target.value)} placeholder="Add a note…" />
                <button type="submit" className="btn primary" disabled={!noteBody.trim()}>Add</button>
              </form>
              {!notes.length ? <EmptyState icon={<IconNote size={18} />} title="No notes" /> : (
                <div className="col-tight">
                  {notes.map((note) => (
                    <div key={note.id} className="card" style={{ padding: 'var(--space-3)', gap: 4 }}>
                      <div className="between">
                        <span className="row-tight small">
                          <Avatar name={note.author_name} size="sm" />
                          {note.author_name || 'Unknown'}
                          {note.pinned ? <Badge tone="warning">pinned</Badge> : null}
                        </span>
                        <span className="xs muted">{relative(note.created_at)}</span>
                      </div>
                      <p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{note.body}</p>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {tab === 'audit' && (
            <Card title="Change history" subtitle="Every field change, and who or what made it">
              {auditTrail.loading ? <Spinner /> : !auditTrail.data?.audit?.length ? (
                <EmptyState icon={<IconClock size={18} />} title="No changes recorded" />
              ) : (
                <div className="col-tight">
                  {auditTrail.data.audit.map((entry) => (
                    <div key={entry.id} className="col-tight" style={{ gap: 2, paddingBottom: 'var(--space-2)', borderBottom: '1px solid var(--surface-border)' }}>
                      <div className="between">
                        <span className="row-tight small">
                          <Badge tone={entry.actor_type === 'ai' ? 'accent' : 'outline'}>{entry.actor_type}</Badge>
                          <span className="strong">{entry.action}</span>
                        </span>
                        <span className="xs muted">{dateTime(entry.created_at)}</span>
                      </div>
                      {entry.diff && (
                        <ul className="list-bullets xs secondary">
                          {Object.entries(entry.diff).filter(([key]) => key !== 'updated_at').slice(0, 6).map(([field, change]) => (
                            <li key={field}>
                              {titleCase(field)}: <span className="suggestion-old">{String(change.from ?? 'not set')}</span> → <strong>{String(change.to ?? 'not set')}</strong>
                            </li>
                          ))}
                        </ul>
                      )}
                      {entry.actor_label && <span className="xs muted">{entry.actor_label}</span>}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}
        </div>

        {/* ------------------------------------------------------ side rail */}
        <div className="col">
          <Card title="Lead score">
            <div className="row gap-4">
              <ScoreRing score={lead.score} size={72} label="Lead score" />
              <div className="grow col-tight">
                <span className="small secondary">
                  Recomputed after each conversation from buying signals, budget clarity, engagement and open objections.
                </span>
                {lead.firstResponseSeconds !== null && lead.firstResponseSeconds !== undefined && (
                  <span className="xs muted">First response time: {elapsedFromMinutes(lead.firstResponseSeconds / 60)}</span>
                )}
              </div>
            </div>
          </Card>

          <Card title="Contact details">
            <KeyValue items={[
              { label: 'Phone', value: lead.phone ? <a href={`tel:${lead.phone}`}>{formatPhone(lead.phone)}</a> : null },
              { label: 'Email', value: lead.email ? <a href={`mailto:${lead.email}`} className="truncate">{lead.email}</a> : null },
              { label: 'Company', value: lead.companyId ? <Link to={`/companies/${lead.companyId}`} className="row-tight"><IconBuilding size={12} /> {lead.companyName}</Link> : lead.companyName },
              { label: 'Job title', value: lead.jobTitle },
              { label: 'Industry', value: lead.industry },
              { label: 'Location', value: lead.location },
              { label: 'Source', value: lead.source ? titleCase(lead.source) : null },
              { label: 'Owner', value: lead.ownerName },
              { label: 'Created', value: date(lead.createdAt) },
              { label: 'Last contact', value: lead.lastContactedAt ? relative(lead.lastContactedAt) : 'never' },
              { label: 'Next follow-up', value: lead.nextFollowUpAt ? dateTime(lead.nextFollowUpAt) : null },
            ]}
            />
          </Card>

          {Object.keys(lead.customFields || {}).length > 0 && (
            <Card title="Custom fields">
              <KeyValue items={Object.entries(lead.customFields).map(([key, value]) => ({
                label: titleCase(key),
                value: typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value),
              }))}
              />
            </Card>
          )}

          {meetings.length > 0 && (
            <Card title="Meetings">
              <div className="col-tight">
                {meetings.slice(0, 5).map((meeting) => (
                  <div key={meeting.id} className="between small">
                    <div className="col-tight" style={{ gap: 0, minWidth: 0 }}>
                      <span className="truncate strong">{meeting.title}</span>
                      <span className="xs muted">{dateTime(meeting.starts_at)}</span>
                    </div>
                    <Badge tone={meeting.status === 'held' ? 'success' : meeting.status === 'no_show' ? 'danger' : 'outline'}>
                      {titleCase(meeting.status)}
                    </Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {messages.length > 0 && (
            <Card title="Messages">
              <div className="col-tight">
                {messages.slice(0, 5).map((message) => (
                  <div key={message.id} className="col-tight" style={{ gap: 1 }}>
                    <div className="between">
                      <Badge tone="outline">{message.channel}</Badge>
                      <span className="xs muted">{relative(message.created_at)}</span>
                    </div>
                    <span className="small secondary">{message.body}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      <EditLeadModal
        open={showEdit}
        onClose={() => setShowEdit(false)}
        lead={lead}
        onSaved={refetch}
        canAssign={can('lead:assign')}
        users={users.data?.users}
      />

      <ComposeEmailDrawer
        open={showEmail}
        onClose={() => setShowEmail(false)}
        lead={lead}
        callId={latestAnalysedCall?.id}
        onSent={() => {
          refetch();
          timeline.refetch();
        }}
      />

      <NewTaskModal
        open={showTask}
        onClose={() => setShowTask(false)}
        leadId={leadId}
        dealId={openDeal?.id}
        onCreated={() => {
          refetch();
          timeline.refetch();
        }}
      />

      <Confirm
        open={confirmArchive}
        title="Archive this lead?"
        message="The record is removed from lists and search but retained for reporting and audit."
        confirmLabel="Archive"
        tone="danger"
        onCancel={() => setConfirmArchive(false)}
        onConfirm={async () => {
          await api.del(`/leads/${leadId}`);
          toast.success('Lead archived');
          navigate('/leads');
        }}
      />
    </>
  );
}

export function NewTaskModal({ open, onClose, leadId, dealId, onCreated, defaultAssignee }) {
  const toast = useToast();
  const [form, setForm] = useState({ title: '', type: 'follow_up', priority: 'medium', dueAt: '', description: '' });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({
        title: '', type: 'follow_up', priority: 'medium',
        dueAt: new Date(Date.now() + 86400000).toISOString().slice(0, 16),
        description: '',
      });
    }
  }, [open]);

  const submit = async (event) => {
    event.preventDefault();
    setPending(true);
    try {
      await api.post('/tasks', {
        ...form,
        leadId: leadId || undefined,
        dealId: dealId || undefined,
        assigneeId: defaultAssignee || undefined,
        dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : undefined,
      });
      toast.success('Task created');
      onCreated?.();
      onClose();
    } catch (error) {
      toast.error(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New task"
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="task-form" className="btn primary" disabled={pending || !form.title}>
            {pending ? <Spinner /> : null} Create task
          </button>
        </>
      )}
    >
      <form id="task-form" className="col" onSubmit={submit}>
        <TextField label="Title" value={form.title} onChange={(event) => setForm((c) => ({ ...c, title: event.target.value }))} required autoFocus />
        <div className="grid grid-2">
          <SelectField
            label="Type"
            value={form.type}
            onChange={(event) => setForm((c) => ({ ...c, type: event.target.value }))}
            options={['call', 'email', 'follow_up', 'demo', 'proposal', 'research', 'meeting'].map((v) => ({ value: v, label: titleCase(v) }))}
          />
          <SelectField
            label="Priority"
            value={form.priority}
            onChange={(event) => setForm((c) => ({ ...c, priority: event.target.value }))}
            options={['low', 'medium', 'high', 'urgent'].map((v) => ({ value: v, label: titleCase(v) }))}
          />
        </div>
        <TextField
          label="Due"
          type="datetime-local"
          value={form.dueAt}
          onChange={(event) => setForm((c) => ({ ...c, dueAt: event.target.value }))}
        />
        <TextArea label="Details" value={form.description} onChange={(event) => setForm((c) => ({ ...c, description: event.target.value }))} rows={3} />
      </form>
    </Modal>
  );
}
