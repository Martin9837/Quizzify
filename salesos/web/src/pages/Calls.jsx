import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import api from '../lib/api.js';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useRealtimeEvent } from '../lib/realtime.jsx';
import {
  PageHeader, Card, Badge, DataTable, Stat, Modal, TextField, Spinner,
  ErrorState, EmptyState, useToast, Tabs, KeyValue,
} from '../components/UI.jsx';
import {
  IconPhone, IconPhoneIncoming, IconSparkles, IconAlert, IconWave,
  IconPlay, IconShield, IconMic, IconClock,
} from '../components/Icons.jsx';
import { duration, dateTime, relative, titleCase, phone as formatPhone, number } from '../lib/format.js';

/**
 * Call centre view: history, live status, and the dialler.
 *
 * The dial pad accepts either a CRM contact or a raw number; either way the call
 * is associated with the right record automatically by the server.
 */

function Dialler({ open, onClose, onDial }) {
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const policy = useApi(open && value.length > 5 ? '/calls/consent-policy' : null, { number: value });

  const dial = async () => {
    setPending(true);
    const result = await onDial({ toNumber: value });
    setPending(false);
    if (result) {
      setValue('');
      onClose();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New call"
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={dial} disabled={pending || value.replace(/\D/g, '').length < 7}>
            {pending ? <Spinner /> : <IconPhone />} Dial
          </button>
        </>
      )}
    >
      <TextField
        label="Phone number"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="+1 555 010 1234"
        hint="International numbers supported. The contact is matched to your CRM automatically."
        autoFocus
      />
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-2)' }}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((key) => (
          <button key={key} type="button" className="btn lg" onClick={() => setValue((current) => current + key)}>{key}</button>
        ))}
      </div>
      <div className="row-tight">
        <button type="button" className="btn grow" onClick={() => setValue((current) => current.slice(0, -1))}>Delete</button>
        <button type="button" className="btn grow" onClick={() => setValue('+')}>+ International</button>
      </div>
      {policy.data && (
        <div className={`banner ${policy.data.policy.requiresConsent ? 'warning' : ''} small`}>
          <IconShield />
          <span>{policy.data.policy.reason}. {policy.data.policy.announcement || ''}</span>
        </div>
      )}
    </Modal>
  );
}

export default function Calls() {
  const toast = useToast();
  const { can, isManager } = useAuth();
  const { startCall } = useOutletContext();
  const [tab, setTab] = useState('all');
  const [showDialler, setShowDialler] = useState(false);
  const [showInbound, setShowInbound] = useState(false);

  const query = {
    limit: 100,
    direction: tab === 'inbound' ? 'inbound' : tab === 'outbound' ? 'outbound' : undefined,
    status: tab === 'missed' ? 'missed' : undefined,
    hasRecording: tab === 'recorded' ? 'true' : undefined,
    analysed: tab === 'analysed' ? 'true' : undefined,
  };
  const { data, loading, error, refetch } = useApi('/calls', query);

  useRealtimeEvent('call.ended', () => refetch());
  useRealtimeEvent('call.started', () => refetch());
  useRealtimeEvent('analysis.ready', () => refetch());

  const calls = data?.calls || [];
  const connected = calls.filter((call) => call.outcome === 'connected' || call.outcome === 'meeting_booked').length;
  const totalTalk = calls.reduce((sum, call) => sum + (call.talkSeconds || 0), 0);
  const analysed = calls.filter((call) => call.aiStatus === 'complete').length;

  const columns = [
    {
      key: 'direction',
      label: '',
      width: 34,
      render: (call) => (
        <span style={{ color: call.direction === 'inbound' ? 'var(--info)' : 'var(--text-muted)', display: 'grid' }} title={titleCase(call.direction)}>
          {call.direction === 'inbound' ? <IconPhoneIncoming size={15} /> : <IconPhone size={15} />}
        </span>
      ),
    },
    {
      key: 'contact',
      label: 'Contact',
      render: (call) => (
        <div className="col-tight" style={{ gap: 0, minWidth: 0 }}>
          {call.leadId ? (
            <Link to={`/leads/${call.leadId}`} className="cell-primary truncate">{call.contactName || 'Unknown'}</Link>
          ) : (
            <span className="cell-primary truncate">{call.contactName || 'Unknown number'}</span>
          )}
          <span className="cell-sub truncate">{call.companyName || call.displayNumber}</span>
        </div>
      ),
    },
    {
      key: 'outcome',
      label: 'Outcome',
      render: (call) => (
        <Badge tone={
          call.outcome === 'connected' || call.outcome === 'meeting_booked' ? 'success'
            : ['missed', 'no_answer', 'failed'].includes(call.status) ? 'danger' : 'outline'
        }
        >
          {titleCase(call.outcome || call.status)}
        </Badge>
      ),
    },
    { key: 'duration', label: 'Duration', numeric: true, render: (call) => <span className="tabular">{duration(call.durationSeconds)}</span> },
    { key: 'talk', label: 'Talk', numeric: true, render: (call) => <span className="tabular muted">{duration(call.talkSeconds)}</span> },
    {
      key: 'ai',
      label: 'AI',
      render: (call) => {
        if (call.aiStatus === 'complete') {
          return (
            <Link to={`/conversations/${call.id}`} className="row-tight small">
              <IconSparkles size={13} />
              {call.callScore !== null && call.callScore !== undefined ? <span className="tabular">{call.callScore}</span> : 'view'}
            </Link>
          );
        }
        if (call.aiStatus === 'processing' || call.aiStatus === 'queued') {
          return <span className="row-tight xs muted"><Spinner /> processing</span>;
        }
        if (call.aiStatus === 'skipped') return <span className="xs muted" title="Too short or not recorded">skipped</span>;
        // 'failed' used to fall through to '--', which is what a call with no
        // recording at all shows -- so a pipeline that gave up looked the same
        // as one that never ran.
        if (call.aiStatus === 'failed') {
          return <span className="xs danger" title="The recording could not be processed. The call itself is logged.">failed</span>;
        }
        return <span className="xs muted">--</span>;
      },
    },
    { key: 'sentiment', label: 'Sentiment', render: (call) => (call.sentiment ? <Badge tone={call.sentiment}>{call.sentiment}</Badge> : <span className="muted">--</span>) },
    ...(isManager ? [{ key: 'agent', label: 'Agent', render: (call) => <span className="small">{call.agentName || '--'}</span> }] : []),
    { key: 'when', label: 'When', render: (call) => <span className="small nowrap" title={dateTime(call.startedAt)}>{relative(call.startedAt)}</span> },
    {
      key: 'actions',
      label: '',
      width: 80,
      render: (call) => (
        <div className="row-tight">
          {call.leadId && (
            <button
              type="button"
              className="btn sm ghost icon"
              title="Call back"
              aria-label="Call back"
              onClick={() => startCall({ leadId: call.leadId })}
            >
              <IconPhone size={13} />
            </button>
          )}
          {call.hasRecording && can('call:recording:listen') && (
            <a
              className="btn sm ghost icon"
              href={`/api/v1/calls/${call.id}/recording`}
              title="Recording"
              aria-label="Open recording"
              target="_blank"
              rel="noreferrer"
            >
              <IconPlay size={13} />
            </a>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Calls"
        subtitle={data ? `${number(data.total)} calls in history` : 'Loading'}
        actions={(
          <>
            <button type="button" className="btn" onClick={() => setShowInbound(true)}>
              <IconPhoneIncoming /> Simulate inbound
            </button>
            <button type="button" className="btn primary" onClick={() => setShowDialler(true)}>
              <IconPhone /> New call
            </button>
          </>
        )}
      />

      <div className="grid grid-4">
        <Stat label="Calls shown" value={number(calls.length)} icon={<IconPhone />} />
        <Stat
          label="Connect rate"
          value={calls.length ? `${Math.round((connected / calls.length) * 100)}%` : '--'}
          meta={`${connected} connected`}
          icon={<IconWave />}
        />
        <Stat label="Talk time" value={duration(totalTalk)} icon={<IconClock />} />
        <Stat label="Analysed by AI" value={number(analysed)} meta="transcript + insights" icon={<IconSparkles />} />
      </div>

      <Card flush>
        <div className="card-body-pad" style={{ paddingBottom: 0 }}>
          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { key: 'all', label: 'All' },
              { key: 'outbound', label: 'Outbound' },
              { key: 'inbound', label: 'Inbound' },
              { key: 'missed', label: 'Missed' },
              { key: 'recorded', label: 'Recorded' },
              { key: 'analysed', label: 'Analysed' },
            ]}
          />
        </div>
        {loading && !data ? (
          <div className="card-body-pad"><Spinner label="Loading calls" /></div>
        ) : error ? (
          <div className="card-body-pad"><ErrorState error={error} onRetry={refetch} /></div>
        ) : (
          <DataTable
            columns={columns}
            rows={calls}
            empty={<EmptyState icon={<IconPhone size={20} />} title="No calls yet" message="Start a call from a lead record or the dialler." />}
          />
        )}
      </Card>

      <Dialler
        open={showDialler}
        onClose={() => setShowDialler(false)}
        onDial={async (payload) => {
          const result = await startCall(payload);
          if (result) refetch();
          return result;
        }}
      />

      <Modal
        open={showInbound}
        onClose={() => setShowInbound(false)}
        title="Simulate an inbound call"
        footer={(
          <>
            <button type="button" className="btn" onClick={() => setShowInbound(false)}>Cancel</button>
            <button
              type="button"
              className="btn primary"
              onClick={async () => {
                const fromNumber = document.getElementById('inbound-number')?.value;
                if (!fromNumber) return;
                try {
                  const result = await api.post('/calls/inbound', { fromNumber });
                  toast.success(result.lead
                    ? `Inbound call from ${result.lead.name} — matched to their CRM record`
                    : 'Inbound call from an unknown number');
                  setShowInbound(false);
                  refetch();
                } catch (error) {
                  toast.error(error);
                }
              }}
            >
              Ring me
            </button>
          </>
        )}
      >
        <p className="small secondary">
          With the simulator provider, this exercises the real inbound path: number matching, CRM
          screen-pop, consent policy and missed-call handling.
        </p>
        <TextField id="inbound-number" label="Caller number" defaultValue="+15552000137" autoFocus />
      </Modal>
    </>
  );
}
