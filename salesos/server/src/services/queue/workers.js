import { get, all, run, parseJson } from '../../db/index.js';
import { nowIso, addDays } from '../../lib/time.js';
import logger from '../../lib/logger.js';
import { registerHandler } from './index.js';
import * as ai from '../ai/index.js';
import * as extraction from '../ai/extraction.js';
import * as telephony from '../telephony/index.js';
import * as automation from '../automation/index.js';
import * as notifications from '../notifications/index.js';
import * as activityLog from '../activity.js';
import * as webhooksService from '../webhooks.js';
import { putObject, recordingKey } from '../storage/index.js';
import { indexRecord } from '../search/index.js';
import { sendEmail } from '../email/index.js';
import { emitToUser } from '../realtime/index.js';
import { orgSettings } from '../org.js';
import config from '../../config.js';

/**
 * Background workers.
 *
 * The post-call pipeline is deliberately split into small jobs
 * (`process_recording` -> `transcribe` -> `analyse`) rather than one long task:
 * each step is retried independently, a transcription failure never loses a
 * recording, and progress is visible to the agent while it runs.
 */

/**
 * What to do when the post-call pipeline runs out of attempts.
 *
 * All three stages set ai_status to 'processing' and only ever moved it to
 * 'complete' or 'skipped'. Nothing wrote a terminal failure, so a recording
 * that could not be fetched or stored left the call reading "AI is processing
 * the recording" for ever -- and the agent had already been told
 * `pipelineQueued: true`. 'failed' is a documented value of the column
 * (db/schema.sql), it simply had no writer.
 */
function abandonAiPipeline(callId, error) {
  const call = get('SELECT agent_id, ai_status FROM calls WHERE id = ?', [callId]);
  if (!call) return;
  // 'complete' wins: a later stage may have finished after an earlier one was
  // retried, and a finished analysis must not be relabelled a failure.
  if (call.ai_status === 'complete') return;
  run(`UPDATE calls SET ai_status = 'failed', updated_at = ? WHERE id = ?`, [nowIso(), callId]);
  emitToUser(call.agent_id, 'call.ai_status', { callId, status: 'failed', error: error?.message || null });
  logger.error('post-call pipeline abandoned', { callId, error: error?.message });
}

export function registerWorkers() {
  // ---------------------------------------------------- simulator progression
  registerHandler('call.simulate_progress', async (payload) => telephony.simulateProgress(payload));

  // ------------------------------------------------------------- recording ---
  registerHandler('call.process_recording', async ({ callId }) => {
    const call = get('SELECT * FROM calls WHERE id = ?', [callId]);
    if (!call) return { skipped: 'call missing' };
    run(`UPDATE calls SET ai_status = 'processing', updated_at = ? WHERE id = ?`, [nowIso(), callId]);
    emitToUser(call.agent_id, 'call.ai_status', { callId, status: 'processing', step: 'recording' });

    const recording = await telephony.provider(call.provider).fetchRecording({
      providerCallId: call.provider_call_id,
      durationSeconds: call.talk_seconds || call.duration_seconds,
    });
    const key = recordingKey(call.organization_id, callId);
    const stored = await putObject(key, recording.buffer, { contentType: recording.contentType });

    run(`UPDATE calls SET recording_object_key = ?, recording_duration_seconds = ?, updated_at = ? WHERE id = ?`,
      [key, recording.durationSeconds || call.talk_seconds, nowIso(), callId]);

    // Chain rather than nest: transcription gets its own retry budget.
    const { enqueue } = await import('./index.js');
    enqueue('call.transcribe', { callId }, { organizationId: call.organization_id, priority: 2 });
    return { key, bytes: stored.bytes, encrypted: stored.encrypted };
  }, { onGiveUp: ({ callId }, error) => abandonAiPipeline(callId, error) });

  // ---------------------------------------------------------- transcription ---
  registerHandler('call.transcribe', async ({ callId }) => {
    const call = get('SELECT * FROM calls WHERE id = ?', [callId]);
    if (!call) return { skipped: 'call missing' };
    emitToUser(call.agent_id, 'call.ai_status', { callId, status: 'processing', step: 'transcribing' });

    const lead = call.lead_id ? get('SELECT * FROM leads WHERE id = ?', [call.lead_id]) : null;
    const deal = call.deal_id ? get('SELECT * FROM deals WHERE id = ?', [call.deal_id]) : null;
    const agent = call.agent_id ? get('SELECT name FROM users WHERE id = ?', [call.agent_id]) : null;

    const { transcript } = await ai.transcribeCall({ call, lead, deal, agentName: agent?.name });

    indexRecord({
      organizationId: call.organization_id,
      entityType: 'transcript',
      entityId: transcript.id,
      ownerId: call.agent_id,
      leadId: call.lead_id,
      occurredAt: call.started_at,
      title: `Call transcript - ${lead ? `${lead.first_name} ${lead.last_name || ''}`.trim() : 'unknown contact'}`,
      body: transcript.full_text,
    });

    emitToUser(call.agent_id, 'transcript.ready', { callId, transcriptId: transcript.id });
    webhooksService.dispatch(call.organization_id, 'transcript.ready', { callId, transcriptId: transcript.id });

    const settings = orgSettings(call.organization_id);
    if (settings.ai?.analysisEnabled !== false) {
      const { enqueue } = await import('./index.js');
      enqueue('call.analyse', { callId, transcriptId: transcript.id }, { organizationId: call.organization_id, priority: 2 });
    } else {
      run(`UPDATE calls SET ai_status = 'complete' WHERE id = ?`, [callId]);
    }
    return { transcriptId: transcript.id, segments: parseJson(transcript.segments, []).length };
  }, { onGiveUp: ({ callId }, error) => abandonAiPipeline(callId, error) });

  // ---------------------------------------------------------------- analysis --
  registerHandler('call.analyse', async ({ callId, transcriptId }) => {
    const call = get('SELECT * FROM calls WHERE id = ?', [callId]);
    if (!call) return { skipped: 'call missing' };
    const transcript = get('SELECT * FROM transcripts WHERE id = ?', [transcriptId])
      || get('SELECT * FROM transcripts WHERE call_id = ? ORDER BY created_at DESC LIMIT 1', [callId]);
    if (!transcript) throw new Error('Transcript not found for analysis');

    emitToUser(call.agent_id, 'call.ai_status', { callId, status: 'processing', step: 'analysing' });

    const lead = call.lead_id ? get('SELECT * FROM leads WHERE id = ?', [call.lead_id]) : null;
    const deal = call.deal_id ? get('SELECT * FROM deals WHERE id = ?', [call.deal_id]) : null;
    const agent = call.agent_id ? get('SELECT name FROM users WHERE id = ?', [call.agent_id]) : null;
    const customFields = all(
      'SELECT key, label, ai_hint FROM custom_field_defs WHERE organization_id = ? AND ai_extractable = 1',
      [call.organization_id],
    );

    const { analysisRow, analysis } = await ai.analyseCall({
      call, transcript, lead, deal, agentName: agent?.name, customFields,
    });

    // CRM suggestions. Policy decides what applies automatically.
    const candidates = extraction.buildSuggestions({ analysis, lead, deal, callDate: call.started_at });
    const suggestions = extraction.persistSuggestions({
      organizationId: call.organization_id,
      sourceType: 'call',
      sourceId: callId,
      candidates,
      actorId: null,
      notifyUserId: call.agent_id,
    });

    // Follow-up proposals (created immediately only if the org opted in).
    const followUps = automation.proposeFollowUps({
      organizationId: call.organization_id, call, analysis, lead, deal,
    });

    run(`UPDATE calls SET ai_status = 'complete', updated_at = ? WHERE id = ?`, [nowIso(), callId]);

    activityLog.log({
      organizationId: call.organization_id,
      leadId: call.lead_id,
      dealId: call.deal_id,
      actorType: 'ai',
      type: 'ai_insight',
      refId: analysisRow.id,
      title: 'AI analysed the call',
      body: analysis.summary,
      metadata: {
        callId,
        sentiment: analysis.sentiment,
        objections: (analysis.objections || []).length,
        buyingSignals: (analysis.buying_signals || []).length,
        suggestions: suggestions.suggestions.length,
        autoApplied: suggestions.autoApplied,
        score: analysis.scorecard?.overall ?? null,
      },
    });

    if (call.agent_id) {
      const pending = suggestions.pending || 0;
      notifications.notify({
        organizationId: call.organization_id,
        userId: call.agent_id,
        type: pending ? 'approval_required' : 'ai_recommendation',
        title: pending
          ? `${pending} CRM update${pending === 1 ? '' : 's'} ready for review`
          : 'Call analysis ready',
        body: analysis.summary?.slice(0, 200) || null,
        entityType: 'call',
        entityId: callId,
        link: `/conversations/${callId}`,
        priority: pending ? 'high' : 'normal',
      });
      emitToUser(call.agent_id, 'analysis.ready', {
        callId,
        analysisId: analysisRow.id,
        batchId: suggestions.batchId,
        pending: suggestions.pending,
        autoApplied: suggestions.autoApplied,
        followUpProposals: followUps.proposals.length,
      });
    }
    webhooksService.dispatch(call.organization_id, 'analysis.ready', {
      callId, analysisId: analysisRow.id, sentiment: analysis.sentiment,
    });

    return {
      analysisId: analysisRow.id,
      suggestions: suggestions.suggestions.length,
      autoApplied: suggestions.autoApplied,
      followUpProposals: followUps.proposals.length,
    };
  }, { onGiveUp: ({ callId }, error) => abandonAiPipeline(callId, error) });

  // ------------------------------------------------------- missed call task ---
  registerHandler('task.create_from_missed_call', async ({ callId }) => {
    const call = get('SELECT * FROM calls WHERE id = ?', [callId]);
    if (!call || !call.agent_id) return { skipped: true };
    const lead = call.lead_id ? get('SELECT * FROM leads WHERE id = ?', [call.lead_id]) : null;
    const task = automation.createTask({
      organizationId: call.organization_id,
      title: lead ? `Call back ${lead.first_name} ${lead.last_name || ''}`.trim() : `Return missed call ${call.masked_number}`,
      description: 'Inbound call was not answered.',
      type: 'call',
      priority: 'high',
      dueAt: nowIso(),
      leadId: call.lead_id,
      callId,
      assigneeId: call.agent_id,
      source: 'automation',
      reason: 'Missed inbound call - return within the hour to protect the response-time SLA.',
      reminderMinutesBefore: 0,
    });
    return { taskId: task.id };
  });

  // ------------------------------------------------------------- email send ---
  registerHandler('email.send', async ({ emailId }) => {
    const email = get('SELECT * FROM emails WHERE id = ?', [emailId]);
    if (!email) return { skipped: 'email missing' };
    if (email.status === 'sent') return { alreadySent: true };

    // Prefer a connected provider integration, but only when it actually holds
    // usable credentials. An integration marked connected with nothing behind it
    // must not turn every outbound email into a hard failure -- fall back to the
    // configured transport and say so in the log.
    const integration = get(
      `SELECT * FROM integrations WHERE organization_id = ? AND category = 'email' AND status = 'connected' LIMIT 1`,
      [email.organization_id],
    );
    let credentials = null;
    let providerName = config.email.provider;
    if (integration?.credentials_enc) {
      try {
        const { decrypt } = await import('../../lib/crypto.js');
        credentials = JSON.parse(decrypt(integration.credentials_enc));
      } catch (error) {
        logger.warn('stored email credentials could not be read', { provider: integration.provider, error: error.message });
        credentials = null;
      }
    }
    if (credentials?.accessToken) {
      providerName = integration.provider.includes('google') ? 'google'
        : integration.provider.includes('microsoft') ? 'microsoft'
          : providerName;
    } else if (integration) {
      logger.debug('email integration has no usable credentials, using the configured transport', {
        provider: integration.provider, fallback: providerName,
      });
    }

    try {
      const result = await sendEmail({
        to: email.to_address,
        cc: parseJson(email.cc, []),
        subject: email.subject,
        body: email.body,
        format: email.body_format,
      }, { provider: providerName, credentials });

      run(`UPDATE emails SET status = 'sent', sent_at = ?, provider = ?, provider_message_id = ?, error = NULL, updated_at = ? WHERE id = ?`,
        [nowIso(), result.provider, result.messageId, nowIso(), emailId]);

      activityLog.log({
        organizationId: email.organization_id,
        leadId: email.lead_id,
        dealId: email.deal_id,
        actorId: email.user_id,
        actorType: email.generated_by_ai && !email.edited_by_human ? 'ai' : 'user',
        type: 'email',
        refId: emailId,
        title: `Email sent: ${email.subject}`,
        body: email.body?.slice(0, 400),
        metadata: { template: email.template, generatedByAi: Boolean(email.generated_by_ai), editedByHuman: Boolean(email.edited_by_human) },
      });

      indexRecord({
        organizationId: email.organization_id,
        entityType: 'email',
        entityId: emailId,
        ownerId: email.user_id,
        leadId: email.lead_id,
        occurredAt: nowIso(),
        title: email.subject || '(no subject)',
        body: email.body,
      });

      if (email.lead_id) {
        run('UPDATE leads SET last_contacted_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), email.lead_id]);
      }
      webhooksService.dispatch(email.organization_id, 'email.sent', { emailId, leadId: email.lead_id, subject: email.subject });
      if (email.user_id) emitToUser(email.user_id, 'email.sent', { emailId, leadId: email.lead_id });
      return { messageId: result.messageId };
    } catch (error) {
      run(`UPDATE emails SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, [error.message, nowIso(), emailId]);
      throw error;
    }
  });

  // ------------------------------------------------- notification e-mailing ---
  registerHandler('notification.email', async ({ notificationId }) => {
    const notification = get('SELECT * FROM notifications WHERE id = ?', [notificationId]);
    if (!notification || notification.emailed_at) return { skipped: true };
    const user = get('SELECT email, name FROM users WHERE id = ?', [notification.user_id]);
    if (!user?.email) return { skipped: 'no address' };

    await sendEmail({
      to: user.email,
      subject: `[SalesOS] ${notification.title}`,
      body: [
        `Hi ${user.name.split(' ')[0]},`,
        '',
        notification.title,
        notification.body || '',
        '',
        notification.link ? `Open in SalesOS: ${config.publicUrl}${notification.link}` : '',
      ].filter(Boolean).join('\n'),
    });
    run('UPDATE notifications SET emailed_at = ? WHERE id = ?', [nowIso(), notificationId]);
    return { sent: true };
  });

  // ----------------------------------------------------------- webhook fanout --
  registerHandler('webhook.deliver', async (payload, job) => webhooksService.deliver({ ...payload, attempt: job.attempts }));

  // ------------------------------------------------------- scheduled sweeps ---
  registerHandler('scheduler.tick', async () => automation.runScheduler());

  registerHandler('retention.enforce', async () => ({ deletions: automation.enforceRetention() }));

  // --------------------------------------------------------- lead import ----
  registerHandler('lead.import_batch', async ({ organizationId, rows, actorId, importId }) => {
    const { importLeads } = await import('../crm.js');
    const result = importLeads({ organizationId, rows, actorId, importId });
    if (actorId) {
      notifications.notify({
        organizationId,
        userId: actorId,
        type: 'new_lead',
        title: `Import complete: ${result.created} leads created`,
        body: `${result.duplicates} duplicate(s) skipped, ${result.errors.length} row(s) rejected.`,
        link: '/leads',
      });
      emitToUser(actorId, 'import.complete', result);
    }
    return result;
  });

  // -------------------------------------------------------- digest e-mails ---
  registerHandler('digest.daily', async ({ organizationId }) => {
    const settings = orgSettings(organizationId);
    if (settings.notifications?.dailyDigest === false) return { skipped: true };
    const agents = all(`SELECT id, name, email FROM users WHERE organization_id = ? AND status = 'active'`, [organizationId]);
    let sent = 0;
    for (const agent of agents) {
      const callList = ai.insights.callListForToday({ organizationId, userId: agent.id, limit: 5 });
      const tasks = get(`SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND status = 'open' AND due_at <= ?`, [agent.id, addDays(1)])?.n || 0;
      if (!callList.length && !tasks) continue;
      notifications.notify({
        organizationId,
        userId: agent.id,
        type: 'ai_recommendation',
        title: `Your day: ${callList.length} calls to make, ${tasks} tasks due`,
        body: callList.slice(0, 3).map((c) => `${c.name}${c.company ? ` (${c.company})` : ''} - ${c.reasons[0]}`).join('; '),
        link: '/',
        channels: ['in_app', 'email'],
      });
      sent += 1;
    }
    return { sent };
  });

  logger.info('workers registered', { count: 12 });
}

export default { registerWorkers };
