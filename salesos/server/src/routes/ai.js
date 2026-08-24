import { Router } from 'express';
import { all, get, parseJson } from '../db/index.js';
import { validate } from '../lib/validate.js';
import { notFound, badRequest, forbidden } from '../lib/errors.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requirePermission, visibleUserIds, assertRecordAccess } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { AI_UPDATABLE_FIELDS, EMAIL_TEMPLATES } from '../lib/constants.js';
import * as ai from '../services/ai/index.js';
import * as extraction from '../services/ai/extraction.js';
import * as insights from '../services/ai/insights.js';
import * as assistant from '../services/ai/assistant.js';
import * as automation from '../services/automation/index.js';
import { orgSettings } from '../services/org.js';
import { startOfDay, endOfDay } from '../lib/time.js';

const router = Router();

// The assistant is the most expensive endpoint per call; it gets its own budget.
const assistantLimiter = rateLimit({ max: 60, windowMs: 60000, scope: 'ai-assistant' });

// GET /ai/status
router.get('/status', asyncHandler(async (req, res) => {
  const settings = orgSettings(req.auth.organizationId);
  res.json({
    ...ai.providerStatus(),
    organizationSettings: {
      crmApproval: settings.crmApproval,
      ai: settings.ai,
      transcription: settings.transcription,
    },
    updatableFields: AI_UPDATABLE_FIELDS,
    emailTemplates: EMAIL_TEMPLATES,
  });
}));

// POST /ai/ask
router.post('/ask', requirePermission('ai:assistant'), assistantLimiter, asyncHandler(async (req, res) => {
  const settings = orgSettings(req.auth.organizationId);
  if (settings.ai?.assistantEnabled === false) throw forbidden('The AI assistant is disabled for this organisation');

  const body = validate(req.body, {
    question: { type: 'string', required: true, maxLength: 2000 },
    conversationId: { type: 'string', maxLength: 40 },
  });
  const history = body.conversationId
    ? (assistant.conversation(req.auth.userId, body.conversationId)?.messages || []).slice(-6)
    : [];

  const result = await assistant.ask({
    user: {
      id: req.auth.userId,
      organizationId: req.auth.organizationId,
      name: req.auth.name,
      role: req.auth.role,
      teamId: req.auth.teamId,
    },
    question: body.question,
    conversationId: body.conversationId,
    history,
  });
  res.json(result);
}));

// GET /ai/conversations
router.get('/conversations', requirePermission('ai:assistant'), asyncHandler(async (req, res) => {
  res.json({ conversations: assistant.conversations(req.auth.userId, 30) });
}));

router.get('/conversations/:conversationId', requirePermission('ai:assistant'), asyncHandler(async (req, res) => {
  const conversation = assistant.conversation(req.auth.userId, req.params.conversationId);
  if (!conversation) throw notFound('Conversation');
  res.json({ conversation });
}));

// GET /ai/insights
router.get('/insights', requirePermission('ai:assistant'), asyncHandler(async (req, res) => {
  const ids = visibleUserIds(req);
  const since = req.query.since || startOfDay(new Date(), -90);
  res.json(insights.insightBundle({
    organizationId: req.auth.organizationId,
    userId: req.auth.userId,
    ownerIds: ids === 'all' ? 'all' : ids,
    since,
  }));
}));

// GET /ai/call-list  -- "who should I call today?"
router.get('/call-list', requirePermission('ai:assistant'), asyncHandler(async (req, res) => {
  res.json({
    callList: insights.callListForToday({
      organizationId: req.auth.organizationId,
      userId: req.query.userId && req.auth.scope !== 'own' ? req.query.userId : req.auth.userId,
      limit: Number(req.query.limit) || 12,
    }),
  });
}));

// ---------------------------------------------------------- suggestions ------
// GET /ai/suggestions
router.get('/suggestions', requirePermission('ai:suggestion:approve'), asyncHandler(async (req, res) => {
  const suggestions = extraction.listSuggestions({
    organizationId: req.auth.organizationId,
    ownerIds: visibleUserIds(req),
    batchId: req.query.batchId,
    entityType: req.query.entityType,
    entityId: req.query.entityId,
    status: req.query.status || 'pending',
    limit: Number(req.query.limit) || 100,
  });

  // Group by batch so the review panel can show "6 updates from Tuesday's call".
  const batches = new Map();
  for (const suggestion of suggestions) {
    const entry = batches.get(suggestion.batchId) || {
      batchId: suggestion.batchId,
      sourceType: suggestion.sourceType,
      sourceId: suggestion.sourceId,
      createdAt: suggestion.createdAt,
      suggestions: [],
    };
    entry.suggestions.push(suggestion);
    batches.set(suggestion.batchId, entry);
  }

  // Attach the originating call so the agent has context for each batch.
  const enriched = [...batches.values()].map((batch) => {
    if (batch.sourceType !== 'call') return batch;
    const call = get(
      `SELECT c.id, c.started_at, l.first_name, l.last_name, l.company_name, a.summary
       FROM calls c LEFT JOIN leads l ON l.id = c.lead_id LEFT JOIN call_analyses a ON a.call_id = c.id
       WHERE c.id = ?`,
      [batch.sourceId],
    );
    return {
      ...batch,
      source: call ? {
        callId: call.id,
        startedAt: call.started_at,
        contactName: call.first_name ? `${call.first_name} ${call.last_name || ''}`.trim() : null,
        companyName: call.company_name,
        summary: call.summary,
      } : null,
    };
  });

  res.json({ suggestions, batches: enriched, total: suggestions.length });
}));

// POST /ai/suggestions/:id/decide
router.post('/suggestions/:suggestionId/decide', requirePermission('ai:suggestion:approve'), asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    action: { type: 'string', required: true, enum: ['approve', 'reject', 'edit'] },
    value: {},
  }, { partial: false });
  if (body.action === 'edit' && body.value === undefined) throw badRequest('An edited value is required');

  const suggestion = get('SELECT * FROM ai_suggestions WHERE id = ? AND organization_id = ?',
    [req.params.suggestionId, req.auth.organizationId]);
  if (!suggestion) throw notFound('Suggestion');

  // Sensitive fields (deal value, stage, close date) need the elevated grant.
  if (suggestion.sensitivity === 'sensitive') {
    const { can } = await import('../lib/permissions.js');
    if (!can(req.auth.role, 'ai:suggestion:approve:sensitive')) {
      throw forbidden('Approving sensitive CRM changes requires additional permission');
    }
  }

  const result = extraction.decide({
    organizationId: req.auth.organizationId,
    suggestionId: req.params.suggestionId,
    action: body.action,
    value: body.value,
    actorId: req.auth.userId,
    ownerIds: visibleUserIds(req),
  });
  res.json(result);
}));

// POST /ai/suggestions/batch/:batchId/decide  -- Approve All / Reject All
router.post('/suggestions/batch/:batchId/decide', requirePermission('ai:suggestion:approve'), asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    action: { type: 'string', required: true, enum: ['approve', 'reject'] },
    only: { type: 'array', of: 'string', maxItems: 100 },
  }, { partial: true });
  const results = extraction.decideBatch({
    organizationId: req.auth.organizationId,
    batchId: req.params.batchId,
    action: body.action,
    actorId: req.auth.userId,
    only: body.only || null,
    ownerIds: visibleUserIds(req),
  });
  res.json({ decided: results.length, suggestions: results });
}));

// ------------------------------------------------------- email generation ----
// POST /ai/email/generate
router.post('/email/generate', requirePermission('email:send'), asyncHandler(async (req, res) => {
  const settings = orgSettings(req.auth.organizationId);
  if (settings.ai?.emailGenerationEnabled === false) throw forbidden('AI email generation is disabled for this organisation');

  const body = validate(req.body, {
    template: { type: 'string', enum: EMAIL_TEMPLATES.map((t) => t.key), default: 'follow_up' },
    leadId: { type: 'string', maxLength: 40 },
    callId: { type: 'string', maxLength: 40 },
    dealId: { type: 'string', maxLength: 40 },
    instructions: { type: 'string', maxLength: 1500 },
    tone: { type: 'string', enum: ['direct', 'warm', 'formal', 'concise'] },
  }, { partial: true });

  let lead = null;
  let call = null;
  let analysis = null;
  let deal = null;

  if (body.callId) {
    call = get('SELECT * FROM calls WHERE id = ? AND organization_id = ?', [body.callId, req.auth.organizationId]);
    if (!call) throw notFound('Call');
    assertRecordAccess(req, call.agent_id);
    analysis = get('SELECT * FROM call_analyses WHERE call_id = ? ORDER BY created_at DESC LIMIT 1', [call.id]);
    if (call.lead_id) lead = get('SELECT * FROM leads WHERE id = ?', [call.lead_id]);
    if (call.deal_id) deal = get('SELECT * FROM deals WHERE id = ?', [call.deal_id]);
  }
  if (!lead && body.leadId) {
    lead = get('SELECT * FROM leads WHERE id = ? AND organization_id = ?', [body.leadId, req.auth.organizationId]);
    if (!lead) throw notFound('Lead');
    assertRecordAccess(req, lead.owner_id);
  }
  if (!deal && body.dealId) deal = get('SELECT * FROM deals WHERE id = ? AND organization_id = ?', [body.dealId, req.auth.organizationId]);
  if (!lead && !body.instructions) throw badRequest('Provide a leadId, a callId, or explicit instructions');

  // Fall back to the most recent analysis for this lead when no call is given.
  if (!analysis && lead) {
    analysis = get(
      `SELECT a.* FROM call_analyses a JOIN calls c ON c.id = a.call_id
       WHERE c.lead_id = ? ORDER BY a.created_at DESC LIMIT 1`,
      [lead.id],
    );
  }

  const hydrated = analysis ? {
    summary: analysis.summary,
    objections: parseJson(analysis.objections, []),
    buying_signals: parseJson(analysis.buying_signals, []),
    commitments: parseJson(analysis.commitments, []),
    next_steps: parseJson(analysis.next_steps, []),
    key_points: parseJson(analysis.key_points, []),
    extraction: parseJson(analysis.extraction, {}),
  } : null;

  const transcriptExcerpt = call
    ? get('SELECT full_text FROM transcripts WHERE call_id = ? ORDER BY created_at DESC LIMIT 1', [call.id])?.full_text?.slice(0, 4000)
    : null;

  const agent = get('SELECT name, title, email FROM users WHERE id = ?', [req.auth.userId]);
  const draft = await ai.generateEmail({
    organizationId: req.auth.organizationId,
    userId: req.auth.userId,
    template: body.template || 'follow_up',
    lead,
    deal,
    analysis: hydrated,
    agent,
    instructions: body.instructions,
    tone: body.tone,
    transcriptExcerpt,
  });

  res.json({
    draft: {
      ...draft,
      to: lead?.email || null,
      template: body.template || 'follow_up',
      leadId: lead?.id || null,
      callId: call?.id || null,
      dealId: deal?.id || null,
    },
  });
}));

// ------------------------------------------------------- follow-up proposals --
// POST /ai/follow-ups/propose
router.post('/follow-ups/propose', requirePermission('task:write'), asyncHandler(async (req, res) => {
  const body = validate(req.body, { callId: { type: 'string', required: true, maxLength: 40 } });
  const call = get('SELECT * FROM calls WHERE id = ? AND organization_id = ?', [body.callId, req.auth.organizationId]);
  if (!call) throw notFound('Call');
  assertRecordAccess(req, call.agent_id);

  const analysisRow = get('SELECT * FROM call_analyses WHERE call_id = ? ORDER BY created_at DESC LIMIT 1', [call.id]);
  if (!analysisRow) throw notFound('Analysis');

  const analysis = {
    summary: analysisRow.summary,
    action_items: parseJson(analysisRow.action_items, []),
    extraction: parseJson(analysisRow.extraction, {}),
  };
  const lead = call.lead_id ? get('SELECT * FROM leads WHERE id = ?', [call.lead_id]) : null;
  const deal = call.deal_id ? get('SELECT * FROM deals WHERE id = ?', [call.deal_id]) : null;

  const result = automation.proposeFollowUps({
    organizationId: req.auth.organizationId, call, analysis, lead, deal,
  });
  res.json(result);
}));

// POST /ai/follow-ups/accept  -- create the approved tasks
router.post('/follow-ups/accept', requirePermission('task:write'), asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    tasks: { type: 'array', required: true, maxItems: 20 },
  });
  const created = [];
  for (const proposal of body.tasks) {
    const data = validate(proposal, {
      title: { type: 'string', required: true, maxLength: 240 },
      type: { type: 'string', maxLength: 30 },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
      dueAt: { type: 'date' },
      leadId: { type: 'string', maxLength: 40 },
      dealId: { type: 'string', maxLength: 40 },
      callId: { type: 'string', maxLength: 40 },
      assigneeId: { type: 'string', maxLength: 40 },
      reason: { type: 'string', maxLength: 500 },
    });
    created.push(automation.createTask({
      organizationId: req.auth.organizationId,
      ...data,
      assigneeId: data.assigneeId || req.auth.userId,
      createdBy: req.auth.userId,
      source: 'ai',
    }));
  }
  res.status(201).json({ created: created.length, tasks: created });
}));

// ------------------------------------------------------------ usage/meter -----
// GET /ai/usage
router.get('/usage', requirePermission('analytics:read'), asyncHandler(async (req, res) => {
  res.json(ai.usageSummary({
    organizationId: req.auth.organizationId,
    since: req.query.since || startOfDay(new Date(), -30),
  }));
}));

// GET /ai/meeting-slots
router.get('/meeting-slots', requirePermission('meeting:write'), asyncHandler(async (req, res) => {
  res.json({
    slots: automation.suggestMeetingSlots({
      organizationId: req.auth.organizationId,
      userId: req.auth.userId,
      durationMinutes: Number(req.query.duration) || 30,
      daysAhead: Number(req.query.days) || 5,
      count: Number(req.query.count) || 5,
    }),
  });
}));

export default router;
