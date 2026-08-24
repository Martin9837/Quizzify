import { get, all, insert, run, parseJson } from '../../db/index.js';
import { id } from '../../lib/ids.js';
import { nowIso } from '../../lib/time.js';
import config from '../../config.js';
import logger from '../../lib/logger.js';
import anthropic from './provider.anthropic.js';
import localEngine from './local-engine.js';
import { writeEmail } from './email-writer.js';
import * as prompts from './prompts.js';
import * as transcription from './transcription.js';
import * as extraction from './extraction.js';
import * as insights from './insights.js';
import * as assistant from './assistant.js';
import { orgSettings } from '../org.js';

/**
 * AI service facade.
 *
 * One rule governs this module: the rest of the application never knows which
 * provider answered. Every entry point returns the same shape whether it was
 * produced by a model or by the built-in deterministic engine, and every call is
 * metered into `ai_usage` so an organisation can see what its AI actually costs.
 */

export const providerStatus = () => ({
  configured: config.ai.provider,
  modelAvailable: anthropic.isConfigured(),
  activeProvider: config.ai.provider === 'local' ? 'local'
    : anthropic.isConfigured() ? 'anthropic' : 'local',
  model: anthropic.isConfigured() ? config.ai.anthropic.model : 'local-engine',
  promptVersion: prompts.PROMPT_VERSION,
  capabilities: {
    transcription: true,
    analysis: true,
    crmExtraction: true,
    emailGeneration: true,
    assistant: true,
    coaching: true,
  },
});

function meter({ organizationId, userId = null, feature, provider, model, usage = {}, latencyMs, success = true, error = null }) {
  insert('ai_usage', {
    id: id('aiu'),
    organization_id: organizationId,
    user_id: userId,
    feature,
    provider,
    model,
    input_tokens: usage.inputTokens || 0,
    output_tokens: usage.outputTokens || 0,
    latency_ms: latencyMs,
    success: success ? 1 : 0,
    error,
    created_at: nowIso(),
  });
}

const useModel = () => config.ai.provider !== 'local' && anthropic.isConfigured();

// ------------------------------------------------------------ transcription --
export async function transcribeCall({ call, lead, deal, agentName, recording }) {
  const settings = orgSettings(call.organization_id);
  const result = await transcription.transcribe({ call, lead, deal, agentName, recording });

  let fullText = result.fullText;
  let redactions = [];
  if (settings.transcription?.redactPii !== false) {
    const redacted = transcription.redact(fullText);
    fullText = redacted.text;
    redactions = redacted.redactions;
  }

  const row = {
    id: id('trs'),
    organization_id: call.organization_id,
    call_id: call.id,
    lead_id: call.lead_id,
    engine: result.engine,
    language: result.language,
    status: 'complete',
    confidence: result.confidence,
    duration_seconds: result.durationSeconds,
    segments: JSON.stringify(result.segments),
    full_text: fullText,
    speakers: JSON.stringify(result.speakers),
    redactions: JSON.stringify(redactions),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('transcripts', row);
  logger.info('transcript stored', { callId: call.id, engine: result.engine, segments: result.segments.length, redactions: redactions.length });
  return { transcript: row, raw: result };
}

// ---------------------------------------------------------------- analysis ---
/**
 * Analyse a transcript. Tries the model first when configured and falls back to
 * the deterministic engine on any failure -- a slow or rate-limited provider
 * degrades quality, never availability.
 */
export async function analyseCall({ call, transcript, lead, deal, agentName, customFields = [] }) {
  const started = Date.now();
  const segments = parseJson(transcript.segments, []);
  let analysis;
  let provider = 'local';
  let model = 'local-engine';
  let usage = {};

  if (useModel()) {
    try {
      const result = await anthropic.structured({
        system: prompts.ANALYSIS_SYSTEM,
        prompt: prompts.analysisUserPrompt({
          transcript: transcript.full_text,
          lead,
          deal,
          callDate: call.started_at || nowIso(),
          agentName,
          customFields,
        }),
        tool: prompts.ANALYSIS_TOOL,
      });
      analysis = normaliseAnalysis(result.data, segments);
      provider = 'anthropic';
      model = result.model;
      usage = result.usage;
    } catch (error) {
      logger.warn('model analysis failed, using local engine', { callId: call.id, error: error.message });
      analysis = localEngine.analyseTranscript({
        segments, fullText: transcript.full_text, lead, deal, callDate: call.started_at,
      });
      provider = 'local-fallback';
    }
  } else {
    analysis = localEngine.analyseTranscript({
      segments, fullText: transcript.full_text, lead, deal, callDate: call.started_at,
    });
  }

  const latencyMs = Date.now() - started;
  const row = {
    id: id('ana'),
    organization_id: call.organization_id,
    call_id: call.id,
    transcript_id: transcript.id,
    lead_id: call.lead_id,
    model,
    provider,
    summary: analysis.summary || null,
    key_points: JSON.stringify(analysis.key_points || []),
    questions: JSON.stringify(analysis.questions || []),
    objections: JSON.stringify(analysis.objections || []),
    buying_signals: JSON.stringify(analysis.buying_signals || []),
    risks: JSON.stringify(analysis.risks || []),
    action_items: JSON.stringify(analysis.action_items || []),
    commitments: JSON.stringify(analysis.commitments || []),
    next_steps: JSON.stringify(analysis.next_steps || []),
    topics: JSON.stringify(analysis.topics || []),
    competitors: JSON.stringify(analysis.competitors || []),
    sentiment: analysis.sentiment || 'neutral',
    sentiment_score: analysis.sentiment_score ?? null,
    talk_ratio: analysis.talk_ratio ?? null,
    extraction: JSON.stringify(analysis.extraction || {}),
    scorecard: JSON.stringify(analysis.scorecard || {}),
    coaching: JSON.stringify(analysis.coaching || {}),
    latency_ms: latencyMs,
    tokens_used: (usage.inputTokens || 0) + (usage.outputTokens || 0),
    created_at: nowIso(),
  };
  insert('call_analyses', row);

  meter({
    organizationId: call.organization_id,
    userId: call.agent_id,
    feature: 'analysis',
    provider,
    model,
    usage,
    latencyMs,
  });

  return { analysisRow: row, analysis };
}

/** Coerce model output into the internal analysis contract. */
function normaliseAnalysis(data, segments) {
  const agentWords = segments.filter((s) => s.role === 'agent').reduce((n, s) => n + s.text.split(/\s+/).length, 0);
  const totalWords = segments.reduce((n, s) => n + s.text.split(/\s+/).length, 0) || 1;
  return {
    summary: data.summary || '',
    key_points: data.key_points || [],
    questions: data.questions || [],
    objections: (data.objections || []).map((o) => ({
      category: o.category, text: o.text, severity: o.severity || 'medium', handled: Boolean(o.handled), evidence: o.evidence || null,
    })),
    buying_signals: data.buying_signals || [],
    risks: data.risks || [],
    action_items: data.action_items || [],
    commitments: data.commitments || [],
    next_steps: data.next_steps || [],
    topics: data.topics || [],
    competitors: data.competitors || [],
    sentiment: data.sentiment || 'neutral',
    sentiment_score: data.sentiment_score ?? null,
    talk_ratio: Math.round((agentWords / totalWords) * 100) / 100,
    extraction: data.extraction || {},
    field_confidence: data.field_confidence || {},
    scorecard: data.scorecard || {},
    coaching: data.coaching || {},
  };
}

// ------------------------------------------------------- email generation ---
export async function generateEmail({ organizationId, userId, template = 'follow_up', lead, deal, analysis, agent, instructions, tone, transcriptExcerpt }) {
  const started = Date.now();
  const definition = (await import('../../lib/constants.js')).EMAIL_TEMPLATES.find((t) => t.key === template);

  if (useModel()) {
    try {
      const result = await anthropic.structured({
        system: prompts.EMAIL_SYSTEM,
        prompt: prompts.emailUserPrompt({
          template,
          intent: definition?.intent || 'Follow up on the conversation.',
          lead,
          deal,
          analysis,
          agent,
          instructions,
          tone,
          transcriptExcerpt,
        }),
        tool: prompts.EMAIL_TOOL,
        temperature: 0.4,
      });
      meter({
        organizationId, userId, feature: 'email', provider: 'anthropic', model: result.model,
        usage: result.usage, latencyMs: Date.now() - started,
      });
      return {
        subject: result.data.subject,
        body: result.data.body,
        talkingPoints: result.data.talking_points || [],
        suggestedSendTime: result.data.suggested_send_time || null,
        provider: 'anthropic',
        model: result.model,
      };
    } catch (error) {
      logger.warn('model email generation failed, using template writer', { error: error.message });
    }
  }

  const drafted = writeEmail({ template, lead, deal, analysis, agent, instructions });
  meter({
    organizationId, userId, feature: 'email', provider: 'local', model: 'local-template',
    latencyMs: Date.now() - started,
  });
  return {
    subject: drafted.subject,
    body: drafted.body,
    talkingPoints: drafted.talking_points,
    suggestedSendTime: null,
    provider: 'local',
    model: 'local-template',
  };
}

// -------------------------------------------------------------- usage view ---
export function usageSummary({ organizationId, since }) {
  const rows = all(
    `SELECT feature, provider, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens, ROUND(AVG(latency_ms)) AS avg_latency_ms,
            SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures
     FROM ai_usage WHERE organization_id = ?${since ? ' AND created_at >= ?' : ''}
     GROUP BY feature, provider ORDER BY calls DESC`,
    since ? [organizationId, since] : [organizationId],
  );
  const totals = rows.reduce((acc, r) => ({
    calls: acc.calls + r.calls,
    inputTokens: acc.inputTokens + (r.input_tokens || 0),
    outputTokens: acc.outputTokens + (r.output_tokens || 0),
    failures: acc.failures + r.failures,
  }), { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 });
  return { byFeature: rows, totals, status: providerStatus() };
}

/** Re-run analysis for a call that already has a transcript. */
export async function reanalyse({ organizationId, callId, actorId }) {
  const call = get('SELECT * FROM calls WHERE id = ? AND organization_id = ?', [callId, organizationId]);
  if (!call) throw new Error('Call not found');
  const transcript = get('SELECT * FROM transcripts WHERE call_id = ? ORDER BY created_at DESC LIMIT 1', [callId]);
  if (!transcript) throw new Error('This call has no transcript to analyse');

  const lead = call.lead_id ? get('SELECT * FROM leads WHERE id = ?', [call.lead_id]) : null;
  const deal = call.deal_id ? get('SELECT * FROM deals WHERE id = ?', [call.deal_id]) : null;
  const agent = call.agent_id ? get('SELECT name FROM users WHERE id = ?', [call.agent_id]) : null;
  const customFields = all(`SELECT key, label, ai_hint FROM custom_field_defs WHERE organization_id = ? AND ai_extractable = 1`, [organizationId]);

  const { analysisRow, analysis } = await analyseCall({
    call, transcript, lead, deal, agentName: agent?.name, customFields,
  });

  const candidates = extraction.buildSuggestions({ analysis, lead, deal, callDate: call.started_at });
  const suggestions = extraction.persistSuggestions({
    organizationId,
    sourceType: 'call',
    sourceId: callId,
    candidates,
    actorId,
    notifyUserId: call.agent_id,
  });

  run(`UPDATE calls SET ai_status = 'complete', updated_at = ? WHERE id = ?`, [nowIso(), callId]);
  return { analysis: analysisRow, suggestions };
}

export { transcription, extraction, insights, assistant, prompts };
export default {
  providerStatus, transcribeCall, analyseCall, generateEmail, usageSummary, reanalyse,
  transcription, extraction, insights, assistant,
};
