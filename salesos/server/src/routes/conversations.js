import { Router } from 'express';
import { all, get, parseJson } from '../db/index.js';
import { validate, parsePagination } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requirePermission, ownerScopeClause, assertRecordAccess, visibleUserIds } from '../middleware/auth.js';
import { COACHING_DIMENSIONS } from '../lib/constants.js';
import * as extraction from '../services/ai/extraction.js';
import * as ai from '../services/ai/index.js';
import { enqueue } from '../services/queue/index.js';
import { humanDuration } from '../lib/time.js';

const router = Router();

const ANALYSIS_JSON = [
  'key_points', 'questions', 'objections', 'buying_signals', 'risks',
  'action_items', 'commitments', 'next_steps', 'topics', 'competitors',
  'extraction', 'scorecard', 'coaching',
];

function analysisView(row) {
  if (!row) return null;
  const view = {
    id: row.id,
    callId: row.call_id,
    transcriptId: row.transcript_id,
    provider: row.provider,
    model: row.model,
    summary: row.summary,
    sentiment: row.sentiment,
    sentimentScore: row.sentiment_score,
    talkRatio: row.talk_ratio,
    latencyMs: row.latency_ms,
    tokensUsed: row.tokens_used,
    createdAt: row.created_at,
  };
  for (const field of ANALYSIS_JSON) {
    const camel = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    view[camel] = parseJson(row[field], field === 'extraction' || field === 'scorecard' || field === 'coaching' ? {} : []);
  }
  return view;
}

// GET /conversations  -- the analysed-call feed
router.get('/', requirePermission('transcript:read'), asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 30, maxLimit: 100 });
  const scope = ownerScopeClause(req, 'c.agent_id', { includeUnassigned: true });
  const params = [req.auth.organizationId, ...scope.params];
  const filters = [];
  if (req.query.sentiment) {
    filters.push('a.sentiment = ?');
    params.push(req.query.sentiment);
  }
  if (req.query.leadId) {
    filters.push('c.lead_id = ?');
    params.push(req.query.leadId);
  }
  if (req.query.agentId) {
    assertRecordAccess(req, req.query.agentId);
    filters.push('c.agent_id = ?');
    params.push(req.query.agentId);
  }
  if (req.query.objection) {
    filters.push(`EXISTS (SELECT 1 FROM json_each(a.objections) WHERE json_extract(json_each.value, '$.category') = ?)`);
    params.push(req.query.objection);
  }
  if (req.query.minScore) {
    filters.push(`json_extract(a.scorecard, '$.overall') >= ?`);
    params.push(Number(req.query.minScore));
  }
  if (req.query.since) {
    filters.push('c.started_at >= ?');
    params.push(req.query.since);
  }

  const where = `WHERE c.organization_id = ?${scope.sql}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`;
  const total = get(`SELECT COUNT(*) AS n FROM calls c JOIN call_analyses a ON a.call_id = c.id ${where}`, params)?.n || 0;
  const rows = all(
    `SELECT c.id AS call_id, c.started_at, c.duration_seconds, c.talk_seconds, c.direction, c.outcome,
            c.ai_status, c.recording_object_key, l.id AS lead_id, l.first_name, l.last_name, l.company_name,
            u.name AS agent_name, a.*,
            (SELECT COUNT(*) FROM ai_suggestions s WHERE s.source_id = c.id AND s.status = 'pending') AS pending_suggestions
     FROM calls c
     JOIN call_analyses a ON a.call_id = c.id
     LEFT JOIN leads l ON l.id = c.lead_id
     LEFT JOIN users u ON u.id = c.agent_id
     ${where} ORDER BY c.started_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  res.json({
    conversations: rows.map((row) => ({
      callId: row.call_id,
      leadId: row.lead_id,
      contactName: row.first_name ? `${row.first_name} ${row.last_name || ''}`.trim() : null,
      companyName: row.company_name,
      agentName: row.agent_name,
      startedAt: row.started_at,
      durationSeconds: row.duration_seconds,
      durationLabel: humanDuration(row.duration_seconds),
      direction: row.direction,
      outcome: row.outcome,
      hasRecording: Boolean(row.recording_object_key),
      pendingSuggestions: row.pending_suggestions,
      analysis: analysisView(row),
    })),
    total,
    limit,
    offset,
  });
}));

// GET /conversations/:callId  -- transcript + analysis + suggestions in one view
router.get('/:callId', requirePermission('transcript:read'), asyncHandler(async (req, res) => {
  const call = get(
    `SELECT c.*, u.name AS agent_name, l.id AS lead_id, l.first_name, l.last_name, l.company_name,
            l.job_title, l.email, l.temperature, l.status AS lead_status
     FROM calls c LEFT JOIN users u ON u.id = c.agent_id LEFT JOIN leads l ON l.id = c.lead_id
     WHERE c.id = ? AND c.organization_id = ?`,
    [req.params.callId, req.auth.organizationId],
  );
  if (!call) throw notFound('Call');
  assertRecordAccess(req, call.agent_id);

  const transcript = get('SELECT * FROM transcripts WHERE call_id = ? ORDER BY created_at DESC LIMIT 1', [call.id]);
  const analysis = get('SELECT * FROM call_analyses WHERE call_id = ? ORDER BY created_at DESC LIMIT 1', [call.id]);
  const deal = call.deal_id ? get('SELECT * FROM deals WHERE id = ?', [call.deal_id]) : null;

  res.json({
    call: {
      id: call.id,
      direction: call.direction,
      status: call.status,
      outcome: call.outcome,
      startedAt: call.started_at,
      endedAt: call.ended_at,
      durationSeconds: call.duration_seconds,
      durationLabel: humanDuration(call.duration_seconds),
      talkSeconds: call.talk_seconds,
      holdSeconds: call.hold_seconds,
      agentId: call.agent_id,
      agentName: call.agent_name,
      leadId: call.lead_id,
      contactName: call.first_name ? `${call.first_name} ${call.last_name || ''}`.trim() : null,
      companyName: call.company_name,
      jobTitle: call.job_title,
      email: call.email,
      temperature: call.temperature,
      notes: call.notes,
      aiStatus: call.ai_status,
      hasRecording: Boolean(call.recording_object_key),
      recordingConsent: call.recording_consent,
      dealId: call.deal_id,
      dealName: deal?.name || null,
      dealStage: deal?.stage || null,
    },
    transcript: transcript ? {
      id: transcript.id,
      engine: transcript.engine,
      language: transcript.language,
      confidence: transcript.confidence,
      durationSeconds: transcript.duration_seconds,
      segments: parseJson(transcript.segments, []),
      speakers: parseJson(transcript.speakers, []),
      redactions: parseJson(transcript.redactions, []),
      fullText: transcript.full_text,
      createdAt: transcript.created_at,
    } : null,
    analysis: analysisView(analysis),
    coachingDimensions: COACHING_DIMENSIONS,
    suggestions: extraction.listSuggestions({
      organizationId: req.auth.organizationId,
      ownerIds: visibleUserIds(req),
      status: 'all',
      limit: 200,
    }).filter((suggestion) => suggestion.sourceId === call.id),
    emails: all(
      `SELECT id, subject, status, template, generated_by_ai, edited_by_human, sent_at, created_at
       FROM emails WHERE call_id = ? ORDER BY created_at DESC`,
      [call.id],
    ),
    tasks: all('SELECT * FROM tasks WHERE call_id = ? ORDER BY due_at ASC', [call.id]),
  });
}));

// GET /conversations/:callId/transcript/search?q=
router.get('/:callId/transcript/search', requirePermission('transcript:read'), asyncHandler(async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) throw notFound('Search term');
  const call = get('SELECT agent_id FROM calls WHERE id = ? AND organization_id = ?', [req.params.callId, req.auth.organizationId]);
  if (!call) throw notFound('Call');
  assertRecordAccess(req, call.agent_id);

  const transcript = get('SELECT segments FROM transcripts WHERE call_id = ? ORDER BY created_at DESC LIMIT 1', [req.params.callId]);
  if (!transcript) throw notFound('Transcript');

  const needle = query.toLowerCase();
  const matches = parseJson(transcript.segments, [])
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => String(segment.text || '').toLowerCase().includes(needle))
    .map(({ segment, index }) => ({
      index,
      role: segment.role,
      speaker: segment.speaker,
      start: segment.start,
      text: segment.text,
      // Highlight offsets let the UI mark matches without re-scanning.
      highlights: [...String(segment.text).toLowerCase().matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))]
        .map((m) => ({ start: m.index, end: m.index + needle.length })),
    }));

  res.json({ query, matches, count: matches.length });
}));

// POST /conversations/:callId/reanalyse
router.post('/:callId/reanalyse', requirePermission('ai:analyze'), asyncHandler(async (req, res) => {
  const call = get('SELECT agent_id FROM calls WHERE id = ? AND organization_id = ?', [req.params.callId, req.auth.organizationId]);
  if (!call) throw notFound('Call');
  assertRecordAccess(req, call.agent_id);
  const result = await ai.reanalyse({
    organizationId: req.auth.organizationId, callId: req.params.callId, actorId: req.auth.userId,
  });
  res.json({ analysis: analysisView(result.analysis), suggestions: result.suggestions });
}));

// POST /conversations/:callId/process  -- run the pipeline for a call that skipped it
router.post('/:callId/process', requirePermission('ai:analyze'), asyncHandler(async (req, res) => {
  const call = get('SELECT * FROM calls WHERE id = ? AND organization_id = ?', [req.params.callId, req.auth.organizationId]);
  if (!call) throw notFound('Call');
  assertRecordAccess(req, call.agent_id);
  const existingTranscript = get('SELECT id FROM transcripts WHERE call_id = ? LIMIT 1', [call.id]);
  const jobType = existingTranscript ? 'call.analyse' : call.recording_object_key ? 'call.transcribe' : 'call.process_recording';
  const jobId = enqueue(jobType, { callId: call.id, transcriptId: existingTranscript?.id },
    { organizationId: req.auth.organizationId, priority: 1 });
  res.status(202).json({ queued: true, jobId, step: jobType });
}));

export default router;
