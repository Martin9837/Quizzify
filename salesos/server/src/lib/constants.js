export const PIPELINE_STAGES = [
  { key: 'new_lead', label: 'New Lead', probability: 5, order: 0 },
  { key: 'contacted', label: 'Contacted', probability: 10, order: 1 },
  { key: 'qualified', label: 'Qualified', probability: 25, order: 2 },
  { key: 'discovery', label: 'Discovery', probability: 40, order: 3 },
  { key: 'demo', label: 'Demo', probability: 55, order: 4 },
  { key: 'proposal', label: 'Proposal', probability: 70, order: 5 },
  { key: 'negotiation', label: 'Negotiation', probability: 85, order: 6 },
  { key: 'won', label: 'Won', probability: 100, order: 7, terminal: true },
  { key: 'lost', label: 'Lost', probability: 0, order: 8, terminal: true },
];

export const STAGE_KEYS = PIPELINE_STAGES.map((s) => s.key);
export const STAGE_MAP = Object.fromEntries(PIPELINE_STAGES.map((s) => [s.key, s]));
export const OPEN_STAGE_KEYS = PIPELINE_STAGES.filter((s) => !s.terminal).map((s) => s.key);

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified', 'customer', 'lost'];
export const LEAD_TEMPERATURES = ['hot', 'warm', 'cold'];
export const LEAD_SOURCES = [
  'inbound_form', 'outbound', 'referral', 'webinar', 'trade_show', 'partner',
  'cold_call', 'linkedin', 'paid_ads', 'content', 'import', 'other',
];

export const CALL_STATUSES = [
  'queued', 'ringing', 'in_progress', 'on_hold', 'completed', 'missed',
  'voicemail', 'failed', 'no_answer', 'transferred',
];
export const CALL_OUTCOMES = [
  'connected', 'voicemail', 'no_answer', 'busy', 'wrong_number',
  'not_interested', 'meeting_booked', 'callback_requested', 'do_not_call',
];

/**
 * The outcomes that mean the prospect was actually reached.
 *
 * `connected` on its own means "spoke to them and nothing more specific
 * happened", so counting only that made every better outcome read as a failure
 * to connect: an agent whose every call booked a meeting showed a 0% connect
 * rate. `wrong_number` is deliberately excluded -- somebody answered, but not
 * the person being called -- as are voicemail, no_answer and busy.
 */
export const CONNECTED_OUTCOMES = [
  'connected', 'meeting_booked', 'callback_requested', 'not_interested', 'do_not_call',
];

/**
 * The same list as a SQL tuple, for the aggregate queries. Safe to interpolate
 * because every value is a literal defined here, never user input.
 */
export const CONNECTED_OUTCOMES_SQL = `('${CONNECTED_OUTCOMES.join("','")}')`;

export const TASK_TYPES = ['call', 'email', 'follow_up', 'demo', 'proposal', 'research', 'meeting'];
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'];

export const EMAIL_TEMPLATES = [
  { key: 'thank_you', label: 'Thank-you email', intent: 'Thank the prospect for their time and recap the conversation.' },
  { key: 'follow_up', label: 'Follow-up', intent: 'Nudge the conversation forward and confirm the agreed next step.' },
  { key: 'proposal_follow_up', label: 'Proposal follow-up', intent: 'Reference the proposal, restate value, and ask for a decision timeline.' },
  { key: 'meeting_confirmation', label: 'Meeting confirmation', intent: 'Confirm date, time, attendees and agenda for the upcoming meeting.' },
  { key: 'product_information', label: 'Product information', intent: 'Share the specific product details the prospect asked about.' },
  { key: 're_engagement', label: 'Re-engagement', intent: 'Re-open a stalled conversation with a low-friction reason to reply.' },
  { key: 'objection_response', label: 'Objection response', intent: 'Address the objection raised on the call with evidence and options.' },
  { key: 'custom', label: 'Custom email', intent: 'Follow the agent instructions supplied with the request.' },
];

export const OBJECTION_CATEGORIES = [
  'pricing', 'budget', 'timing', 'authority', 'competitor', 'features',
  'integration', 'security', 'contract_terms', 'status_quo', 'trust', 'support',
];

export const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'];

export const COACHING_DIMENSIONS = [
  { key: 'opening', label: 'Opening', weight: 1 },
  { key: 'discovery', label: 'Discovery questions', weight: 1.5 },
  { key: 'product_knowledge', label: 'Product knowledge', weight: 1 },
  { key: 'objection_handling', label: 'Objection handling', weight: 1.5 },
  { key: 'listening', label: 'Listening', weight: 1.25 },
  { key: 'engagement', label: 'Customer engagement', weight: 1 },
  { key: 'closing', label: 'Closing technique', weight: 1.25 },
  { key: 'next_step', label: 'Next-step confirmation', weight: 1.5 },
];

export const NOTIFICATION_TYPES = [
  'new_lead', 'missed_call', 'follow_up', 'task', 'deal', 'manager_alert',
  'ai_recommendation', 'meeting', 'approval_required',
];

export const ACTIVITY_TYPES = [
  'call', 'email', 'sms', 'whatsapp', 'meeting', 'note', 'task',
  'crm_change', 'ai_insight', 'stage_change', 'lead_created', 'assignment',
];

export const WEBHOOK_EVENTS = [
  'lead.created', 'lead.updated', 'lead.assigned',
  'deal.created', 'deal.stage_changed', 'deal.won', 'deal.lost',
  'call.started', 'call.completed', 'call.missed',
  'transcript.ready', 'analysis.ready',
  'email.sent', 'task.created', 'task.completed',
  'meeting.scheduled', 'ai.suggestions.ready',
];

// Fields the AI may propose. `sensitive: true` means the change always needs a
// human decision unless the org explicitly opts into full automation.
export const AI_UPDATABLE_FIELDS = [
  { entity: 'lead', field: 'temperature', label: 'Lead temperature', type: 'enum', sensitive: false, options: LEAD_TEMPERATURES },
  { entity: 'lead', field: 'status', label: 'Lead status', type: 'enum', sensitive: false, options: LEAD_STATUSES },
  { entity: 'lead', field: 'score', label: 'Lead score', type: 'number', sensitive: false },
  { entity: 'lead', field: 'next_follow_up_at', label: 'Follow-up date', type: 'date', sensitive: false },
  { entity: 'lead', field: 'job_title', label: 'Job title', type: 'string', sensitive: false },
  { entity: 'lead', field: 'industry', label: 'Industry', type: 'string', sensitive: false },
  { entity: 'lead', field: 'email', label: 'Email address', type: 'string', sensitive: true },
  { entity: 'lead', field: 'tags', label: 'Tags', type: 'array', sensitive: false },
  { entity: 'deal', field: 'stage', label: 'Deal stage', type: 'enum', sensitive: true, options: STAGE_KEYS },
  { entity: 'deal', field: 'value', label: 'Deal value', type: 'number', sensitive: true },
  { entity: 'deal', field: 'budget', label: 'Budget', type: 'number', sensitive: true },
  { entity: 'deal', field: 'probability', label: 'Probability', type: 'number', sensitive: false },
  { entity: 'deal', field: 'expected_close_date', label: 'Expected close date', type: 'date', sensitive: true },
  { entity: 'deal', field: 'timeline', label: 'Timeline', type: 'string', sensitive: false },
  { entity: 'deal', field: 'decision_maker', label: 'Decision maker', type: 'string', sensitive: false },
  { entity: 'deal', field: 'competitors', label: 'Competitors', type: 'array', sensitive: false },
  { entity: 'deal', field: 'pain_points', label: 'Pain points', type: 'array', sensitive: false },
  { entity: 'deal', field: 'requirements', label: 'Requirements', type: 'array', sensitive: false },
  { entity: 'deal', field: 'product', label: 'Product discussed', type: 'string', sensitive: false },
  { entity: 'deal', field: 'lost_reason', label: 'Lost reason', type: 'string', sensitive: true },
];

export const AI_FIELD_MAP = Object.fromEntries(AI_UPDATABLE_FIELDS.map((f) => [`${f.entity}.${f.field}`, f]));

// Default organisation settings. Tenants override any subset.
export const DEFAULT_ORG_SETTINGS = {
  crmApproval: {
    // 'suggest' -> AI proposes, human approves. 'auto' -> apply immediately.
    mode: 'suggest',
    autoApplyConfidenceThreshold: 0.85,
    // Sensitive fields still require approval even in 'auto' mode unless this
    // is explicitly disabled by an administrator.
    alwaysReviewSensitive: true,
    autoCreateTasks: false,
  },
  recording: {
    enabled: true,
    // all_party consent is the safest default; regional overrides below.
    consentMode: 'all_party', // all_party|one_party|disabled
    playAnnouncement: true,
    regionOverrides: {
      US_CA: { consentMode: 'all_party' },
      'US-NY': { consentMode: 'one_party' },
      DE: { consentMode: 'all_party' },
      GB: { consentMode: 'one_party' },
    },
    retentionDays: 365,
  },
  transcription: {
    enabled: true,
    redactPii: true,
    language: 'en',
    // Calls shorter than this are not worth transcribing (misdials, wrong
    // numbers, voicemail beeps). Configurable because the useful floor
    // differs between a two-minute qualification call and a 20-second
    // appointment confirmation.
    minimumCallSeconds: 5,
  },
  ai: {
    analysisEnabled: true,
    emailGenerationEnabled: true,
    assistantEnabled: true,
    coachingEnabled: true,
    followUpSuggestionsEnabled: true,
  },
  dataRetention: {
    transcriptDays: 730,
    recordingDays: 365,
    auditLogDays: 2555,
    activityDays: 1825,
  },
  notifications: { emailReminders: true, dailyDigest: true, managerAlerts: true },
  security: {
    sessionTimeoutMinutes: 720,
    requireMfaForAdmins: false,
    ipAllowlist: [],
    passwordMinLength: 10,
  },
  quotas: { monthlyCallTarget: 400, monthlyRevenueTarget: 250000 },
};
