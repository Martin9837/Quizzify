import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api.js';
import { useToast, Badge, Spinner } from './UI.jsx';
import { useTicker } from '../lib/hooks.js';
import { useRealtimeEvent } from '../lib/realtime.jsx';
import { clock, phone as formatPhone, titleCase } from '../lib/format.js';
import {
  IconMic, IconMicOff, IconPause, IconPlay, IconTransfer, IconHangup,
  IconPhoneIncoming, IconNote, IconExternal, IconShield, IconSparkles,
} from './Icons.jsx';

/**
 * The live call dock.
 *
 * Deliberately the simplest screen in the product: an agent using it is talking
 * to a human at the same time. Large targets, one row of controls, the contact's
 * CRM context visible without scrolling, and a notes box that saves on hang-up.
 */

const CALL_OUTCOMES = [
  'connected', 'meeting_booked', 'callback_requested', 'not_interested',
  'voicemail', 'no_answer', 'wrong_number', 'do_not_call',
];

export default function CallDock({ call, context, lead, consent, onEnded, onUpdate }) {
  const toast = useToast();
  const [notes, setNotes] = useState('');
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [consentAsked, setConsentAsked] = useState(call?.recordingConsent !== 'pending');

  const live = ['queued', 'ringing', 'in_progress', 'on_hold'].includes(call?.status);
  useTicker(1000, live);

  useRealtimeEvent('call.updated', (payload) => {
    if (payload?.id === call?.id) onUpdate?.(payload);
  });
  useRealtimeEvent('call.answered', (payload) => {
    if (payload?.id === call?.id) onUpdate?.(payload);
  });
  useRealtimeEvent('call.ended', (payload) => {
    if (payload?.id === call?.id) onUpdate?.(payload);
  });

  const elapsed = useMemo(() => {
    if (!call?.startedAt) return 0;
    const from = call.answeredAt || call.startedAt;
    const to = call.endedAt ? new Date(call.endedAt) : new Date();
    return Math.max(0, Math.round((to - new Date(from)) / 1000));
  }, [call?.startedAt, call?.answeredAt, call?.endedAt, useTicker]);

  const act = async (label, request) => {
    setBusy(label);
    try {
      const result = await request();
      if (result?.call) onUpdate?.(result.call);
      return result;
    } catch (error) {
      toast.error(error);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const hangUp = async () => {
    const result = await act('end', () => api.post(`/calls/${call.id}/end`, {
      outcome: outcome || undefined,
      notes: notes.trim() || undefined,
    }));
    if (result) {
      toast.success(result.pipelineQueued
        ? 'Call ended. Transcribing and analysing now.'
        : 'Call logged.');
      onEnded?.(result);
    }
  };

  if (!call) return null;

  const statusTone = call.status === 'in_progress' ? 'success'
    : call.status === 'ringing' ? 'warning'
      : call.status === 'on_hold' ? 'info' : 'outline';

  return (
    <section className="call-dock" aria-label="Active call">
      <header className="call-dock-head">
        <span className={call.status === 'ringing' ? 'pulse' : ''} style={{ color: 'var(--accent)', display: 'grid' }}>
          <IconPhoneIncoming size={18} />
        </span>
        <div className="grow col-tight" style={{ gap: 0 }}>
          <strong className="truncate">
            {lead ? lead.name : formatPhone(call.toNumber)}
          </strong>
          <span className="xs muted truncate">
            {lead?.companyName ? `${lead.companyName}${lead.jobTitle ? ` · ${lead.jobTitle}` : ''}` : formatPhone(call.toNumber)}
          </span>
        </div>
        <div className="col-tight" style={{ alignItems: 'flex-end', gap: 2 }}>
          <span className="call-timer">{clock(elapsed)}</span>
          <Badge tone={statusTone} dot>{titleCase(call.status)}</Badge>
        </div>
      </header>

      <div className="call-dock-body">
        {/* Consent capture. Shown before anything else when the region needs it. */}
        {!consentAsked && consent?.requiresConsent && (
          <div className="banner warning small col-tight">
            <div className="row-tight">
              <IconShield />
              <strong>Recording consent required</strong>
            </div>
            <span>{consent.announcement || 'Ask permission before recording this call.'}</span>
            <div className="row-tight">
              <button
                type="button"
                className="btn success sm"
                onClick={async () => {
                  await act('consent', () => api.post(`/calls/${call.id}/consent`, { granted: true, method: 'verbal' }));
                  setConsentAsked(true);
                }}
              >
                Consent given
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={async () => {
                  await act('consent', () => api.post(`/calls/${call.id}/consent`, { granted: false, method: 'verbal' }));
                  setConsentAsked(true);
                  toast.info('Recording disabled for this call');
                }}
              >
                Declined
              </button>
            </div>
          </div>
        )}

        {call.recordingEnabled && (
          <div className="row-tight xs muted">
            <span className="badge danger dot">Recording</span>
            <span>Transcript and AI analysis will run after the call</span>
          </div>
        )}

        {live ? (
          <div className="call-controls">
            <button
              type="button"
              className={`call-control ${call.muted ? 'active' : ''}`}
              onClick={() => act('mute', () => api.post(`/calls/${call.id}/mute`, { muted: !call.muted }))}
              disabled={busy === 'mute'}
            >
              {call.muted ? <IconMicOff /> : <IconMic />}
              {call.muted ? 'Unmute' : 'Mute'}
            </button>
            <button
              type="button"
              className={`call-control ${call.onHold ? 'active' : ''}`}
              onClick={() => act('hold', () => api.post(`/calls/${call.id}/hold`, { onHold: !call.onHold }))}
              disabled={busy === 'hold'}
            >
              {call.onHold ? <IconPlay /> : <IconPause />}
              {call.onHold ? 'Resume' : 'Hold'}
            </button>
            <button
              type="button"
              className="call-control"
              onClick={async () => {
                const destination = window.prompt('Transfer to (phone number or extension)');
                if (destination) {
                  await act('transfer', () => api.post(`/calls/${call.id}/transfer`, { destination }));
                  toast.success('Call transferred');
                }
              }}
              disabled={busy === 'transfer'}
            >
              <IconTransfer />
              Transfer
            </button>
            <button type="button" className="call-control end" onClick={hangUp} disabled={busy === 'end'}>
              {busy === 'end' ? <Spinner /> : <IconHangup />}
              End
            </button>
          </div>
        ) : (
          <div className="banner success small">
            <IconSparkles />
            <span>Call ended. {call.aiStatus === 'queued' || call.aiStatus === 'processing' ? 'AI is processing the recording.' : 'Logged to the CRM.'}</span>
          </div>
        )}

        <label className="field">
          <span className="sr-only">Call notes</span>
          <textarea
            className="textarea"
            style={{ minHeight: 62 }}
            placeholder="Notes (saved when the call ends)"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>

        {live && (
          <select className="select" value={outcome} onChange={(event) => setOutcome(event.target.value)} aria-label="Call outcome">
            <option value="">Set outcome on hang-up…</option>
            {CALL_OUTCOMES.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}
          </select>
        )}

        {/* CRM context: what the agent needs mid-sentence. */}
        {context && (
          <div className="col-tight">
            <button
              type="button"
              className="between small"
              onClick={() => setExpanded((value) => !value)}
              style={{ background: 'transparent', border: 0, padding: 0, width: '100%' }}
              aria-expanded={expanded}
            >
              <span className="row-tight strong"><IconNote /> CRM context</span>
              <span className="muted">{expanded ? 'Hide' : 'Show'}</span>
            </button>
            {expanded && (
              <div className="col-tight small">
                {context.lastCall?.summary && (
                  <div className="col-tight" style={{ gap: 2 }}>
                    <span className="uppercase muted">Last conversation</span>
                    <p className="secondary" style={{ margin: 0 }}>{context.lastCall.summary}</p>
                  </div>
                )}
                {context.openTasks?.length > 0 && (
                  <div className="col-tight" style={{ gap: 2 }}>
                    <span className="uppercase muted">Open tasks</span>
                    <ul className="list-bullets">
                      {context.openTasks.slice(0, 3).map((task) => <li key={task.id}>{task.title}</li>)}
                    </ul>
                  </div>
                )}
                {context.notes?.length > 0 && (
                  <div className="col-tight" style={{ gap: 2 }}>
                    <span className="uppercase muted">Notes</span>
                    <p className="secondary" style={{ margin: 0 }}>{context.notes[0].body}</p>
                  </div>
                )}
                {lead?.id && (
                  <Link to={`/leads/${lead.id}`} className="row-tight small">
                    Open full CRM record <IconExternal size={13} />
                  </Link>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
