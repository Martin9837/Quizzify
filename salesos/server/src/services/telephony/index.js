import { insert, get, all, run, transaction } from '../../db/index.js';
import { id } from '../../lib/ids.js';
import { nowIso, secondsBetween, addSeconds } from '../../lib/time.js';
import { toE164, countryFromE164, callingCode, maskNumber, proxyNumber } from '../../lib/phone.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import config from '../../config.js';
import logger from '../../lib/logger.js';
import simulator from './provider.simulator.js';
import twilio from './provider.twilio.js';
import device from './provider.device.js';
import { enqueue } from '../queue/index.js';
import { emitToOrg, emitToUser } from '../realtime/index.js';
import * as activity from '../activity.js';
import * as audit from '../audit.js';
import * as notifications from '../notifications/index.js';
import * as webhooks from '../webhooks.js';
import { indexRecord } from '../search/index.js';
import { orgSettings } from '../org.js';

const providers = { simulator, twilio, device };

export function provider(name = config.telephony.provider) {
  return providers[name] || simulator;
}

// ------------------------------------------------------ consent handling ----
/**
 * Resolve the recording consent requirement for a destination.
 *
 * Call-recording law varies by jurisdiction: some require every party to
 * consent, others only one. Rather than hard-coding a single behaviour we read
 * the organisation policy plus per-region overrides, and surface the resulting
 * obligation to the agent before the call connects.
 */
export function resolveConsentPolicy(settings, { country, region } = {}) {
  const recording = settings.recording || {};
  if (recording.enabled === false) {
    return { mode: 'disabled', requiresConsent: false, announcement: null, reason: 'Recording disabled for this organisation' };
  }
  const overrides = recording.regionOverrides || {};
  const override = (region && overrides[region]) || (country && overrides[country]) || null;
  const mode = override?.consentMode || recording.consentMode || 'all_party';

  if (mode === 'disabled') {
    return { mode, requiresConsent: false, announcement: null, reason: 'Recording not permitted in this region' };
  }
  const requiresConsent = mode === 'all_party';
  return {
    mode,
    requiresConsent,
    announcement: recording.playAnnouncement
      ? 'This call may be recorded for quality and training purposes.'
      : null,
    reason: requiresConsent
      ? 'All-party consent region: capture explicit consent before recording'
      : 'One-party consent region: agent consent is sufficient',
  };
}

// ----------------------------------------------------------- lead lookup ----
/** Match an inbound/outbound number back to a CRM record. */
export function findLeadByNumber(organizationId, e164) {
  if (!e164) return null;
  const tail = e164.slice(-9);
  return (
    get('SELECT * FROM leads WHERE organization_id = ? AND phone_e164 = ? AND archived_at IS NULL', [organizationId, e164]) ||
    get(
      `SELECT * FROM leads WHERE organization_id = ? AND archived_at IS NULL
        AND (phone_e164 LIKE ? OR secondary_phone LIKE ?) LIMIT 1`,
      [organizationId, `%${tail}`, `%${tail}`],
    ) ||
    null
  );
}

function logCallEvent(call, type, payload = {}) {
  insert('call_events', {
    id: id('cev'),
    organization_id: call.organization_id,
    call_id: call.id,
    type,
    payload: JSON.stringify(payload),
    created_at: nowIso(),
  });
}

function broadcast(call, event = 'call.updated') {
  const view = toView(call);
  emitToOrg(call.organization_id, event, view);
  if (call.agent_id) emitToUser(call.agent_id, event, view);
  return view;
}

export function toView(call) {
  return {
    id: call.id,
    leadId: call.lead_id,
    dealId: call.deal_id,
    agentId: call.agent_id,
    direction: call.direction,
    status: call.status,
    outcome: call.outcome,
    toNumber: call.to_number,
    fromNumber: call.from_number,
    maskedNumber: call.masked_number,
    startedAt: call.started_at,
    answeredAt: call.answered_at,
    endedAt: call.ended_at,
    durationSeconds: call.duration_seconds,
    talkSeconds: call.talk_seconds,
    holdSeconds: call.hold_seconds,
    muted: Boolean(call.muted),
    onHold: Boolean(call.on_hold),
    recordingEnabled: Boolean(call.recording_enabled),
    recordingConsent: call.recording_consent,
    hasRecording: Boolean(call.recording_object_key),
    aiStatus: call.ai_status,
    notes: call.notes,
    provider: call.provider,
  };
}

// --------------------------------------------------------- outbound calls ---
export async function placeCall({ organizationId, agent, leadId = null, toNumber = null, recordingRequested = true, dealId = null, viaDevice = false }) {
  const settings = orgSettings(organizationId);
  let lead = null;

  if (leadId) {
    lead = get('SELECT * FROM leads WHERE id = ? AND organization_id = ?', [leadId, organizationId]);
    if (!lead) throw notFound('Lead');
  }
  const destination = toE164(toNumber || lead?.phone_e164 || lead?.phone, lead?.country || 'US');
  if (!destination) throw badRequest('A destination phone number is required');

  // Resolve the contact by number BEFORE the do-not-call check, not after.
  // With the check first, dialling a flagged contact's raw number instead of
  // naming the lead skipped it entirely -- `lead` was still null when the check
  // ran, so it passed, and the association was only made afterwards. Dialling a
  // typed-in number is exactly how someone would reach a number they should not
  // be calling, and do-not-call is a legal control rather than a convenience.
  if (!lead) lead = findLeadByNumber(organizationId, destination);

  if (lead?.do_not_call) throw conflict('This contact is on the do-not-call list');

  const country = lead?.country || countryFromE164(destination);
  const consent = resolveConsentPolicy(settings, { country, region: lead?.location });
  // A call is only recorded when the org allows it, the agent asked for it, and
  // consent is either not required or already on file for this contact.
  const consentOnFile = lead?.consent_recording === 'granted';
  // A call placed on the agent's own handset can never be recorded -- the app has
  // no access to the carrier audio -- so the request is overridden rather than
  // recorded as an intention that was silently not honoured.
  const recordingEnabled = Boolean(
    !viaDevice && recordingRequested && consent.mode !== 'disabled' && (!consent.requiresConsent || consentOnFile),
  );
  const providerName = viaDevice ? 'device' : config.telephony.provider;

  const activeDeal = dealId
    ? get('SELECT * FROM deals WHERE id = ? AND organization_id = ?', [dealId, organizationId])
    : lead
      ? get(`SELECT * FROM deals WHERE lead_id = ? AND stage NOT IN ('won','lost') ORDER BY updated_at DESC LIMIT 1`, [lead.id])
      : null;

  const callId = id('call');
  const fromNumber = proxyNumber(config.telephony.callerId, agent.phone, config.telephony.maskingEnabled);
  const now = nowIso();

  const record = {
    id: callId,
    organization_id: organizationId,
    lead_id: lead?.id || null,
    deal_id: activeDeal?.id || null,
    agent_id: agent.id,
    provider: providerName,
    provider_call_id: null,
    direction: 'outbound',
    from_number: fromNumber,
    to_number: destination,
    masked_number: config.telephony.maskingEnabled ? maskNumber(destination) : destination,
    country_code: callingCode(destination),
    status: 'queued',
    started_at: now,
    duration_seconds: 0,
    talk_seconds: 0,
    hold_seconds: 0,
    recording_enabled: recordingEnabled ? 1 : 0,
    recording_consent: consent.requiresConsent ? (consentOnFile ? 'granted' : 'pending') : 'not_required',
    consent_method: consentOnFile ? 'written' : consent.announcement ? 'announcement' : 'policy',
    ai_status: 'none',
    tags: '[]',
    created_at: now,
    updated_at: now,
  };
  insert('calls', record);
  logCallEvent(record, 'dial', { to: record.masked_number, recordingEnabled });

  let dial;
  try {
    dial = await provider(providerName).placeCall({
      to: destination, from: fromNumber, callId, recordingEnabled,
    });
  } catch (error) {
    run(`UPDATE calls SET status = 'failed', ended_at = ?, updated_at = ? WHERE id = ?`, [nowIso(), nowIso(), callId]);
    logger.error('dial failed', { callId, error: error.message });
    throw error;
  }

  run(`UPDATE calls SET provider_call_id = ?, status = 'ringing', updated_at = ? WHERE id = ?`,
    [dial.providerCallId, nowIso(), callId]);
  logCallEvent(record, 'ring', { providerCallId: dial.providerCallId });

  // The simulator advances on its own so the full pipeline is demo-able; a real
  // provider drives the same transitions through status webhooks.
  if (provider(providerName).name === 'simulator') {
    enqueue('call.simulate_progress', { callId, projectedOutcome: dial.projectedOutcome },
      { organizationId, delaySeconds: Math.max(1, dial.ringSeconds || 2), priority: 1 });
  }

  const stored = get('SELECT * FROM calls WHERE id = ?', [callId]);
  broadcast(stored, 'call.started');
  webhooks.dispatch(organizationId, 'call.started', { callId, leadId: stored.lead_id, direction: 'outbound' });

  return {
    call: toView(stored),
    lead,
    deal: activeDeal || null,
    consent,
    providerCallId: dial.providerCallId,
    // The E.164 number the handset should dial. Only for a device call, where the
    // client has to hand it to the system dialer; a provider call is already
    // connected server-side and has no use for it.
    dialNumber: viaDevice ? destination : null,
  };
}

export async function answerCall({ organizationId, callId }) {
  const call = requireCall(organizationId, callId);
  if (!['ringing', 'queued'].includes(call.status)) return toView(call);
  await provider(call.provider).answer(call.provider_call_id);
  const answeredAt = nowIso();
  run(`UPDATE calls SET status = 'in_progress', answered_at = ?, updated_at = ? WHERE id = ?`, [answeredAt, answeredAt, callId]);
  const updated = get('SELECT * FROM calls WHERE id = ?', [callId]);
  logCallEvent(updated, 'answer', {});
  return broadcast(updated, 'call.answered');
}

export async function setHold({ organizationId, callId, onHold }) {
  const call = requireCall(organizationId, callId);
  await provider(call.provider).hold(call.provider_call_id, onHold);
  // Hold time is accumulated so talk-time analytics stay honest.
  const holdDelta = !onHold && call.on_hold ? secondsBetween(lastEventAt(call, 'hold') || call.answered_at || call.started_at, nowIso()) : 0;
  run('UPDATE calls SET on_hold = ?, hold_seconds = hold_seconds + ?, updated_at = ? WHERE id = ?',
    [onHold ? 1 : 0, holdDelta, nowIso(), callId]);
  const updated = get('SELECT * FROM calls WHERE id = ?', [callId]);
  logCallEvent(updated, onHold ? 'hold' : 'unhold', {});
  return broadcast(updated);
}

export async function setMute({ organizationId, callId, muted }) {
  const call = requireCall(organizationId, callId);
  await provider(call.provider).mute(call.provider_call_id, muted);
  run('UPDATE calls SET muted = ?, updated_at = ? WHERE id = ?', [muted ? 1 : 0, nowIso(), callId]);
  const updated = get('SELECT * FROM calls WHERE id = ?', [callId]);
  logCallEvent(updated, 'mute', { muted });
  return broadcast(updated);
}

export async function transferCall({ organizationId, callId, destination, actorId }) {
  const call = requireCall(organizationId, callId);
  const target = destination.startsWith('user_')
    ? get('SELECT phone, name FROM users WHERE id = ? AND organization_id = ?', [destination, organizationId])
    : null;
  const number = target?.phone ? toE164(target.phone) : toE164(destination);
  if (!number) throw badRequest('A valid transfer destination is required');
  await provider(call.provider).transfer(call.provider_call_id, number);
  run(`UPDATE calls SET transferred_to = ?, status = 'transferred', updated_at = ? WHERE id = ?`,
    [number, nowIso(), callId]);
  const updated = get('SELECT * FROM calls WHERE id = ?', [callId]);
  logCallEvent(updated, 'transfer', { to: maskNumber(number), label: target?.name || null });
  audit.record({
    organizationId, actorId, action: 'call.transfer', entityType: 'call', entityId: callId,
    after: { transferred_to: maskNumber(number) }, source: 'ui',
  });
  return broadcast(updated);
}

export async function sendDigits({ organizationId, callId, digits }) {
  const call = requireCall(organizationId, callId);
  const result = await provider(call.provider).sendDigits(call.provider_call_id, digits);
  logCallEvent(call, 'dtmf', result);
  return result;
}

/** Record the consent decision captured verbally at the top of a call. */
export function recordConsent({ organizationId, callId, granted, method = 'verbal', actorId }) {
  const call = requireCall(organizationId, callId);
  const consent = granted ? 'granted' : 'denied';
  run('UPDATE calls SET recording_consent = ?, consent_method = ?, recording_enabled = ?, updated_at = ? WHERE id = ?',
    [consent, method, granted ? 1 : 0, nowIso(), callId]);
  if (call.lead_id) {
    run('UPDATE leads SET consent_recording = ?, updated_at = ? WHERE id = ? AND organization_id = ?',
      [consent, nowIso(), call.lead_id, organizationId]);
  }
  const updated = get('SELECT * FROM calls WHERE id = ?', [callId]);
  logCallEvent(updated, 'consent', { granted, method });
  audit.record({
    organizationId, actorId, action: 'call.consent', entityType: 'call', entityId: callId,
    after: { recording_consent: consent, consent_method: method }, source: 'ui',
  });
  return broadcast(updated);
}

// ------------------------------------------------------------- hang up ------
export async function endCall({ organizationId, callId, outcome = null, notes = null, status = 'completed', actorId = null }) {
  const call = requireCall(organizationId, callId);
  if (['completed', 'missed', 'voicemail', 'failed', 'no_answer'].includes(call.status) && call.ended_at) {
    return { call: toView(call), alreadyEnded: true };
  }
  try {
    await provider(call.provider).hangup(call.provider_call_id);
  } catch (error) {
    logger.warn('provider hangup failed', { callId, error: error.message });
  }

  const endedAt = nowIso();
  const startedAt = call.started_at || endedAt;
  const duration = secondsBetween(startedAt, endedAt);

  // On a device call the carrier tells us nothing, so answered_at is never set and
  // the agent is the only witness to what happened. Take them at their word when
  // they report a conversation, or the CRM would file every call they made from
  // their own handset as a no-answer. Provider calls are untouched: there the
  // provider observed the call and a claimed outcome must not overwrite it.
  //
  // Talk time is then the whole handoff window rather than true connected time,
  // which is the closest thing available -- nothing reports when the callee
  // actually picked up.
  const answeredAt = call.answered_at
    || (call.provider === 'device' && outcome === 'connected' ? startedAt : null);
  const talk = answeredAt ? Math.max(0, secondsBetween(answeredAt, endedAt) - (call.hold_seconds || 0)) : 0;

  const finalStatus = answeredAt ? status : status === 'completed' ? 'no_answer' : status;
  const finalOutcome = outcome || (answeredAt ? 'connected' : finalStatus === 'voicemail' ? 'voicemail' : 'no_answer');

  transaction(() => {
    run(
      `UPDATE calls SET status = ?, outcome = ?, answered_at = ?, ended_at = ?, duration_seconds = ?,
         talk_seconds = ?, notes = COALESCE(?, notes), on_hold = 0, updated_at = ? WHERE id = ?`,
      [finalStatus, finalOutcome, answeredAt, endedAt, duration, talk, notes, endedAt, callId],
    );
    if (call.lead_id) {
      const lead = get('SELECT * FROM leads WHERE id = ?', [call.lead_id]);
      const responseSeconds = lead?.first_response_seconds ?? (lead ? secondsBetween(lead.created_at, endedAt) : null);
      run(
        `UPDATE leads SET last_contacted_at = ?, status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END,
           first_response_seconds = COALESCE(first_response_seconds, ?), updated_at = ? WHERE id = ?`,
        [endedAt, responseSeconds, endedAt, call.lead_id],
      );
    }
  });

  const updated = get('SELECT * FROM calls WHERE id = ?', [callId]);
  logCallEvent(updated, 'hangup', { outcome: finalOutcome, duration });

  activity.log({
    organizationId,
    leadId: updated.lead_id,
    dealId: updated.deal_id,
    actorId: updated.agent_id,
    type: 'call',
    refId: callId,
    title: `${updated.direction === 'inbound' ? 'Inbound' : 'Outbound'} call - ${finalOutcome.replace(/_/g, ' ')}`,
    body: notes || null,
    metadata: { durationSeconds: duration, talkSeconds: talk, status: finalStatus, recorded: Boolean(updated.recording_enabled) },
    occurredAt: endedAt,
  });

  indexRecord({
    organizationId,
    entityType: 'call',
    entityId: callId,
    ownerId: updated.agent_id,
    leadId: updated.lead_id,
    occurredAt: endedAt,
    title: `${updated.direction} call - ${finalOutcome}`,
    body: [notes, finalOutcome, updated.to_number].filter(Boolean).join(' '),
  });

  audit.record({
    organizationId, actorId: actorId || updated.agent_id, action: 'call.end', entityType: 'call', entityId: callId,
    after: { status: finalStatus, outcome: finalOutcome, duration_seconds: duration }, source: 'ui',
  });

  broadcast(updated, 'call.ended');
  webhooks.dispatch(organizationId, 'call.completed', {
    callId, leadId: updated.lead_id, outcome: finalOutcome, durationSeconds: duration,
  });

  // Post-call pipeline. Recording -> transcript -> analysis -> suggestions.
  const settings = orgSettings(organizationId);
  const minimumSeconds = settings.transcription?.minimumCallSeconds ?? 5;
  const eligible = Boolean(updated.recording_enabled)
    && duration >= minimumSeconds
    && settings.transcription?.enabled !== false;
  if (eligible) {
    run(`UPDATE calls SET ai_status = 'queued' WHERE id = ?`, [callId]);
    enqueue('call.process_recording', { callId }, { organizationId, priority: 2 });
  } else if (updated.recording_enabled) {
    run(`UPDATE calls SET ai_status = 'skipped' WHERE id = ?`, [callId]);
  }

  if (['missed', 'no_answer'].includes(finalStatus) && updated.direction === 'inbound') {
    handleMissedCall(updated);
  }

  return {
    call: toView(get('SELECT * FROM calls WHERE id = ?', [callId])),
    pipelineQueued: eligible,
    // Surfaced so the UI can explain a missing transcript rather than
    // leaving the agent wondering where the analysis went.
    skipReason: eligible ? null
      : !updated.recording_enabled ? 'not_recorded'
        : settings.transcription?.enabled === false ? 'transcription_disabled'
          : `shorter_than_${minimumSeconds}s`,
  };
}

// -------------------------------------------------------- inbound calls -----
export async function receiveCall({ organizationId, fromNumber, toNumber, providerCallId = null, agentId = null }) {
  const from = toE164(fromNumber);
  const lead = findLeadByNumber(organizationId, from);
  const settings = orgSettings(organizationId);
  const consent = resolveConsentPolicy(settings, { country: countryFromE164(from), region: lead?.location });

  // Route to the record owner when we know them, otherwise leave unassigned for
  // the queue to pick up.
  const targetAgent = agentId || lead?.owner_id || null;
  const now = nowIso();
  const callId = id('call');

  insert('calls', {
    id: callId,
    organization_id: organizationId,
    lead_id: lead?.id || null,
    agent_id: targetAgent,
    provider: config.telephony.provider,
    provider_call_id: providerCallId,
    direction: 'inbound',
    from_number: from,
    to_number: toE164(toNumber) || config.telephony.callerId,
    masked_number: maskNumber(from),
    country_code: callingCode(from),
    status: 'ringing',
    started_at: now,
    recording_enabled: consent.mode !== 'disabled' && !consent.requiresConsent ? 1 : 0,
    recording_consent: consent.requiresConsent ? 'pending' : 'not_required',
    ai_status: 'none',
    created_at: now,
    updated_at: now,
  });

  const call = get('SELECT * FROM calls WHERE id = ?', [callId]);
  logCallEvent(call, 'ring', { inbound: true });
  broadcast(call, 'call.incoming');
  if (targetAgent) {
    emitToUser(targetAgent, 'call.incoming', { ...toView(call), lead: lead ? { id: lead.id, name: `${lead.first_name} ${lead.last_name || ''}`.trim(), company: lead.company_name } : null });
  }
  return { call: toView(call), lead, consent };
}

function handleMissedCall(call) {
  const lead = call.lead_id ? get('SELECT * FROM leads WHERE id = ?', [call.lead_id]) : null;
  const name = lead ? `${lead.first_name} ${lead.last_name || ''}`.trim() : maskNumber(call.from_number);
  if (call.agent_id) {
    notifications.notify({
      organizationId: call.organization_id,
      userId: call.agent_id,
      type: 'missed_call',
      title: `Missed call from ${name}`,
      body: lead?.company_name ? `${lead.company_name} - call back to keep the deal moving` : 'Unknown caller - review and call back',
      priority: 'high',
      entityType: 'call',
      entityId: call.id,
      link: lead ? `/leads/${lead.id}` : '/calls',
      channels: ['in_app', 'email'],
    });
  }
  webhooks.dispatch(call.organization_id, 'call.missed', { callId: call.id, leadId: call.lead_id });
  // Missed inbound calls become a follow-up task automatically: the single most
  // common source of lost pipeline is a call nobody returned.
  if (call.agent_id) {
    enqueue('task.create_from_missed_call', { callId: call.id }, { organizationId: call.organization_id, priority: 4 });
  }
}

// ------------------------------------------------------------- voicemail ----
export function markVoicemail({ organizationId, callId, objectKey, durationSeconds }) {
  const call = requireCall(organizationId, callId);
  run(`UPDATE calls SET status = 'voicemail', outcome = 'voicemail', voicemail_object_key = ?,
        recording_duration_seconds = ?, ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ?`,
    [objectKey, durationSeconds, nowIso(), nowIso(), callId]);
  const updated = get('SELECT * FROM calls WHERE id = ?', [callId]);
  activity.log({
    organizationId, leadId: updated.lead_id, actorId: updated.agent_id, type: 'call', refId: callId,
    title: 'Voicemail left', metadata: { durationSeconds },
  });
  return broadcast(updated);
}

// -------------------------------------------------------------- helpers -----
function requireCall(organizationId, callId) {
  const call = get('SELECT * FROM calls WHERE id = ? AND organization_id = ?', [callId, organizationId]);
  if (!call) throw notFound('Call');
  return call;
}

function lastEventAt(call, type) {
  const row = get('SELECT created_at FROM call_events WHERE call_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1',
    [call.id, type]);
  return row?.created_at || null;
}

export function callEvents(organizationId, callId) {
  requireCall(organizationId, callId);
  return all('SELECT * FROM call_events WHERE call_id = ? ORDER BY created_at ASC', [callId]);
}

export function activeCallsFor(organizationId, userId) {
  return all(
    `SELECT * FROM calls WHERE organization_id = ? AND agent_id = ?
       AND status IN ('queued','ringing','in_progress','on_hold') ORDER BY created_at DESC`,
    [organizationId, userId],
  ).map(toView);
}

/** Simulator-only state machine step, driven by the queue. */
export async function simulateProgress({ callId, projectedOutcome }) {
  const call = get('SELECT * FROM calls WHERE id = ?', [callId]);
  if (!call || call.status !== 'ringing') return { skipped: true };

  if (projectedOutcome === 'answered') {
    const answeredAt = nowIso();
    run(`UPDATE calls SET status = 'in_progress', answered_at = ?, updated_at = ? WHERE id = ?`,
      [answeredAt, answeredAt, callId]);
    const updated = get('SELECT * FROM calls WHERE id = ?', [callId]);
    logCallEvent(updated, 'answer', { simulated: true });
    broadcast(updated, 'call.answered');
    return { status: 'in_progress' };
  }

  const status = projectedOutcome === 'voicemail' ? 'voicemail' : projectedOutcome === 'busy' ? 'failed' : 'no_answer';
  await endCall({ organizationId: call.organization_id, callId, status, outcome: projectedOutcome });
  return { status };
}

export default {
  placeCall, answerCall, endCall, setHold, setMute, transferCall, sendDigits, recordConsent,
  receiveCall, markVoicemail, callEvents, activeCallsFor, simulateProgress, resolveConsentPolicy,
  findLeadByNumber, toView, provider,
};
