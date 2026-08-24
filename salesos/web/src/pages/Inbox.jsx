import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../lib/api.js';
import { useApi } from '../lib/hooks.js';
import { useRealtimeEvent } from '../lib/realtime.jsx';
import {
  PageHeader, Card, Badge, Stat, Tabs, Drawer, Spinner, ErrorState, EmptyState,
  TextField, TextArea, SelectField, KeyValue, useToast,
} from '../components/UI.jsx';
import { IconMail, IconSparkles, IconPlus, IconCheck, IconRobot, IconEdit } from '../components/Icons.jsx';
import { relative, dateTime, titleCase, number, percent } from '../lib/format.js';

/**
 * Email workspace. Everything sent from SalesOS is logged here with whether the
 * AI drafted it and whether a human edited it before sending -- the two numbers
 * that tell you if AI email generation is actually working.
 */

function Composer({ open, onClose, onSent }) {
  const toast = useToast();
  const [leadId, setLeadId] = useState('');
  const [template, setTemplate] = useState('follow_up');
  const [instructions, setInstructions] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(null);
  const [pending, setPending] = useState(false);

  const leads = useApi(open ? '/leads' : null, { limit: 200 });
  const meta = useApi(open ? '/ai/status' : null);
  const lead = (leads.data?.leads || []).find((l) => l.id === leadId);

  const generate = async () => {
    setPending(true);
    try {
      const result = await api.post('/ai/email/generate', { template, leadId, instructions: instructions || undefined });
      setDraft(result.draft);
      setSubject(result.draft.subject);
      setBody(result.draft.body);
    } catch (error) {
      toast.error(error);
    } finally {
      setPending(false);
    }
  };

  const send = async () => {
    setPending(true);
    try {
      const created = await api.post('/emails', { leadId, to: lead?.email, subject, body, template, generatedByAi: Boolean(draft) });
      await api.post(`/emails/${created.email.id}/send`);
      toast.success('Email sent and logged');
      onSent?.();
      onClose();
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
      wide
      title="Compose email"
      footer={(
        <div className="row-tight">
          <button type="button" className="btn grow" onClick={generate} disabled={pending || !leadId}>
            {pending ? <Spinner /> : <IconSparkles />} {draft ? 'Regenerate' : 'Generate with AI'}
          </button>
          <button type="button" className="btn primary grow" onClick={send} disabled={pending || !subject || !body || !lead?.email}>
            <IconMail /> Send
          </button>
        </div>
      )}
    >
      <SelectField
        label="Recipient"
        value={leadId}
        placeholder="Choose a contact"
        onChange={(event) => setLeadId(event.target.value)}
        options={(leads.data?.leads || []).filter((l) => l.email).map((l) => ({
          value: l.id, label: `${l.name} — ${l.companyName || l.email}`,
        }))}
      />
      <SelectField
        label="Email type"
        value={template}
        onChange={(event) => setTemplate(event.target.value)}
        options={(meta.data?.emailTemplates || []).map((t) => ({ value: t.key, label: t.label }))}
      />
      <TextArea label="Instructions for the AI (optional)" value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={2} />
      <TextField label="Subject" value={subject} onChange={(event) => setSubject(event.target.value)} />
      <TextArea label="Body" value={body} onChange={(event) => setBody(event.target.value)} rows={12} />
      {draft?.talkingPoints?.length > 0 && (
        <Card title="What the draft is based on">
          <ul className="list-bullets small secondary">
            {draft.talkingPoints.map((point, index) => <li key={index}>{point}</li>)}
          </ul>
        </Card>
      )}
    </Drawer>
  );
}

export default function Inbox() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState('all');
  const [showCompose, setShowCompose] = useState(searchParams.get('compose') === '1');
  const [selected, setSelected] = useState(null);

  const { data, loading, error, refetch } = useApi('/emails', {
    limit: 100,
    status: tab === 'sent' ? 'sent' : tab === 'draft' ? 'draft' : tab === 'failed' ? 'failed' : undefined,
    aiOnly: tab === 'ai' ? 'true' : undefined,
  });

  useRealtimeEvent('email.sent', () => refetch());

  const emails = data?.emails || [];
  const aiDrafted = emails.filter((email) => email.generatedByAi).length;
  const edited = emails.filter((email) => email.generatedByAi && email.editedByHuman).length;
  const opened = emails.filter((email) => email.openedAt).length;
  const replied = emails.filter((email) => email.repliedAt).length;

  return (
    <>
      <PageHeader
        title="Email"
        subtitle={data ? `${number(data.total)} messages logged` : 'Loading'}
        actions={<button type="button" className="btn primary" onClick={() => setShowCompose(true)}><IconPlus /> Compose</button>}
      />

      <div className="grid grid-4">
        <Stat label="Messages" value={number(emails.length)} icon={<IconMail />} />
        <Stat
          label="AI drafted"
          value={number(aiDrafted)}
          meta={aiDrafted ? `${percent((edited / aiDrafted) * 100)} edited before sending` : 'none yet'}
          icon={<IconRobot />}
        />
        <Stat label="Opened" value={emails.length ? percent((opened / emails.length) * 100) : '--'} icon={<IconCheck />} />
        <Stat label="Replied" value={emails.length ? percent((replied / emails.length) * 100) : '--'} icon={<IconMail />} />
      </div>

      <Card flush>
        <div className="card-body-pad" style={{ paddingBottom: 0 }}>
          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { key: 'all', label: 'All' },
              { key: 'sent', label: 'Sent' },
              { key: 'draft', label: 'Drafts' },
              { key: 'ai', label: 'AI drafted' },
              { key: 'failed', label: 'Failed' },
            ]}
          />
        </div>
        <div className="card-body-pad">
          {loading && !data && <Spinner label="Loading email" />}
          {error && <ErrorState error={error} onRetry={refetch} />}
          {!loading && !emails.length && (
            <EmptyState icon={<IconMail size={20} />} title="No email yet" message="Generate a follow-up from a call and it will appear here." />
          )}
          <div className="col-tight">
            {emails.map((email) => (
              <button
                key={email.id}
                type="button"
                className="between"
                style={{ background: 'transparent', border: 0, borderBottom: '1px solid var(--surface-border)', padding: 'var(--space-2) 0', textAlign: 'left', width: '100%' }}
                onClick={() => setSelected(email)}
              >
                <div className="col-tight grow" style={{ gap: 2, minWidth: 0 }}>
                  <div className="row-tight wrap">
                    <span className="small strong truncate">{email.subject}</span>
                    {email.generatedByAi && (
                      <Badge tone="accent"><IconSparkles size={10} /> AI{email.editedByHuman ? ' · edited' : ''}</Badge>
                    )}
                    <Badge tone={email.status === 'sent' ? 'success' : email.status === 'failed' ? 'danger' : 'outline'}>{email.status}</Badge>
                  </div>
                  <span className="xs muted truncate">
                    {email.contactName || email.to}
                    {email.companyName ? ` · ${email.companyName}` : ''}
                    {email.template ? ` · ${titleCase(email.template)}` : ''}
                  </span>
                </div>
                <div className="col-tight" style={{ alignItems: 'flex-end', gap: 1 }}>
                  <span className="xs muted nowrap">{relative(email.sentAt || email.createdAt)}</span>
                  <span className="xs muted row-tight">
                    {email.openedAt && <Badge tone="outline">opened</Badge>}
                    {email.repliedAt && <Badge tone="success">replied</Badge>}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </Card>

      <Composer
        open={showCompose}
        onClose={() => {
          setShowCompose(false);
          searchParams.delete('compose');
          setSearchParams(searchParams, { replace: true });
        }}
        onSent={refetch}
      />

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} wide title={selected?.subject || 'Email'}>
        {selected && (
          <div className="col">
            <KeyValue items={[
              { label: 'To', value: selected.to },
              { label: 'Status', value: <Badge tone={selected.status === 'sent' ? 'success' : 'outline'}>{selected.status}</Badge> },
              { label: 'Template', value: selected.template ? titleCase(selected.template) : null },
              { label: 'Sent', value: selected.sentAt ? dateTime(selected.sentAt) : null },
              { label: 'Opened', value: selected.openedAt ? dateTime(selected.openedAt) : null },
              { label: 'Replied', value: selected.repliedAt ? dateTime(selected.repliedAt) : null },
              { label: 'Drafted by', value: selected.generatedByAi ? `AI${selected.editedByHuman ? ', edited by a human' : ''}` : 'Human' },
              { label: 'Error', value: selected.error },
            ]}
            />
            <hr className="divider" />
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>{selected.body}</div>
            {selected.leadId && <Link to={`/leads/${selected.leadId}`} className="btn">Open CRM record</Link>}
          </div>
        )}
      </Drawer>
    </>
  );
}
