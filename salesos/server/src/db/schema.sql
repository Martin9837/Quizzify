-- ============================================================================
-- SalesOS schema. Multi-tenant (organization_id on every business table),
-- append-only audit trail, and FTS5 indexes for global/natural-language search.
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- tenancy ---
CREATE TABLE IF NOT EXISTS organizations (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  plan              TEXT NOT NULL DEFAULT 'growth',      -- starter|growth|enterprise
  seats             INTEGER NOT NULL DEFAULT 10,
  currency          TEXT NOT NULL DEFAULT 'USD',
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  -- Settings are JSON documents so tenants can diverge without migrations.
  settings          TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  region            TEXT,
  manager_id        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(organization_id);

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  name              TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  role              TEXT NOT NULL,                       -- agent|manager|admin|super_admin
  team_id           TEXT REFERENCES teams(id) ON DELETE SET NULL,
  title             TEXT,
  phone             TEXT,
  avatar_color      TEXT,
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  quota_amount      REAL NOT NULL DEFAULT 0,             -- monthly revenue quota
  status            TEXT NOT NULL DEFAULT 'active',      -- active|invited|suspended
  preferences       TEXT NOT NULL DEFAULT '{}',
  last_login_at     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (organization_id, email)
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_users_team ON users(team_id);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id   TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  user_agent        TEXT,
  ip                TEXT,
  expires_at        TEXT NOT NULL,
  revoked_at        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  prefix            TEXT NOT NULL,
  key_hash          TEXT NOT NULL,
  scopes            TEXT NOT NULL DEFAULT '[]',
  created_by        TEXT REFERENCES users(id),
  last_used_at      TEXT,
  revoked_at        TEXT,
  created_at        TEXT NOT NULL
);

-- ------------------------------------------------------------------- CRM ----
CREATE TABLE IF NOT EXISTS companies (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  domain            TEXT,
  industry          TEXT,
  size              TEXT,
  location          TEXT,
  annual_revenue    REAL,
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companies_org ON companies(organization_id);

CREATE TABLE IF NOT EXISTS leads (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id        TEXT REFERENCES companies(id) ON DELETE SET NULL,
  first_name        TEXT NOT NULL,
  last_name         TEXT,
  company_name      TEXT,
  job_title         TEXT,
  phone             TEXT,
  phone_e164        TEXT,
  secondary_phone   TEXT,
  email             TEXT,
  location          TEXT,
  country           TEXT,
  timezone          TEXT,
  source            TEXT,                                -- inbound|outbound|referral|webinar...
  industry          TEXT,
  status            TEXT NOT NULL DEFAULT 'new',         -- new|contacted|qualified|unqualified|customer|lost
  temperature       TEXT NOT NULL DEFAULT 'cold',        -- hot|warm|cold
  score             INTEGER NOT NULL DEFAULT 0,          -- 0..100
  tags              TEXT NOT NULL DEFAULT '[]',
  owner_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  deal_value        REAL DEFAULT 0,
  expected_close_date TEXT,
  next_follow_up_at TEXT,
  last_contacted_at TEXT,
  first_response_seconds INTEGER,                        -- lead response time metric
  do_not_call       INTEGER NOT NULL DEFAULT 0,
  consent_recording TEXT NOT NULL DEFAULT 'unknown',     -- granted|denied|unknown
  custom_fields     TEXT NOT NULL DEFAULT '{}',
  ai_snapshot       TEXT NOT NULL DEFAULT '{}',          -- rolling AI-derived profile
  dedupe_key        TEXT,
  archived_at       TEXT,
  created_by        TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_org ON leads(organization_id);
CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(organization_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_followup ON leads(organization_id, next_follow_up_at);
CREATE INDEX IF NOT EXISTS idx_leads_dedupe ON leads(organization_id, dedupe_key);

CREATE TABLE IF NOT EXISTS deals (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id           TEXT REFERENCES leads(id) ON DELETE CASCADE,
  company_id        TEXT REFERENCES companies(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  stage             TEXT NOT NULL DEFAULT 'new_lead',
  value             REAL NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'USD',
  probability       INTEGER NOT NULL DEFAULT 10,
  expected_close_date TEXT,
  owner_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  product           TEXT,
  competitors       TEXT NOT NULL DEFAULT '[]',
  pain_points       TEXT NOT NULL DEFAULT '[]',
  requirements      TEXT NOT NULL DEFAULT '[]',
  decision_maker    TEXT,
  budget            REAL,
  timeline          TEXT,
  risk_score        INTEGER NOT NULL DEFAULT 0,          -- 0..100 (higher = more at risk)
  risk_reasons      TEXT NOT NULL DEFAULT '[]',
  health            TEXT NOT NULL DEFAULT 'unknown',     -- healthy|watch|at_risk
  stage_entered_at  TEXT,
  closed_at         TEXT,
  lost_reason       TEXT,
  position          INTEGER NOT NULL DEFAULT 0,          -- kanban ordering
  custom_fields     TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deals_org ON deals(organization_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(organization_id, stage);
CREATE INDEX IF NOT EXISTS idx_deals_owner ON deals(organization_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_deals_lead ON deals(lead_id);

CREATE TABLE IF NOT EXISTS deal_stage_history (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL,
  deal_id           TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  from_stage        TEXT,
  to_stage          TEXT NOT NULL,
  changed_by        TEXT,
  source            TEXT NOT NULL DEFAULT 'user',        -- user|ai|automation
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stagehist_deal ON deal_stage_history(deal_id);

-- ---------------------------------------------------------------- calling ---
CREATE TABLE IF NOT EXISTS calls (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id           TEXT REFERENCES leads(id) ON DELETE SET NULL,
  deal_id           TEXT REFERENCES deals(id) ON DELETE SET NULL,
  agent_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  provider          TEXT NOT NULL DEFAULT 'simulator',
  provider_call_id  TEXT,
  direction         TEXT NOT NULL,                       -- outbound|inbound
  from_number       TEXT,
  to_number         TEXT,
  masked_number     TEXT,                                -- what the counterparty sees
  country_code      TEXT,
  status            TEXT NOT NULL DEFAULT 'queued',      -- queued|ringing|in_progress|on_hold|completed|missed|voicemail|failed|no_answer|transferred
  outcome           TEXT,                                -- connected|voicemail|no_answer|wrong_number|not_interested|meeting_booked
  disposition_note  TEXT,
  started_at        TEXT,
  answered_at       TEXT,
  ended_at          TEXT,
  duration_seconds  INTEGER NOT NULL DEFAULT 0,
  talk_seconds      INTEGER NOT NULL DEFAULT 0,
  hold_seconds      INTEGER NOT NULL DEFAULT 0,
  muted             INTEGER NOT NULL DEFAULT 0,
  on_hold           INTEGER NOT NULL DEFAULT 0,
  transferred_to    TEXT,
  recording_enabled INTEGER NOT NULL DEFAULT 0,
  recording_consent TEXT NOT NULL DEFAULT 'not_required',-- granted|denied|not_required|pending
  consent_method    TEXT,                                -- verbal|announcement|written|policy
  recording_object_key TEXT,
  recording_duration_seconds INTEGER,
  recording_deleted_at TEXT,
  voicemail_object_key TEXT,
  notes             TEXT,
  tags              TEXT NOT NULL DEFAULT '[]',
  ai_status         TEXT NOT NULL DEFAULT 'none',        -- none|queued|processing|complete|failed|skipped
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_org ON calls(organization_id);
CREATE INDEX IF NOT EXISTS idx_calls_agent ON calls(organization_id, agent_id, started_at);
CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(organization_id, status);

CREATE TABLE IF NOT EXISTS call_events (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL,
  call_id           TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,                       -- dial|ring|answer|hold|unhold|mute|transfer|dtmf|hangup|consent
  payload           TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_callevents_call ON call_events(call_id);

CREATE TABLE IF NOT EXISTS transcripts (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id           TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  lead_id           TEXT,
  engine            TEXT NOT NULL DEFAULT 'local',
  language          TEXT NOT NULL DEFAULT 'en',
  status            TEXT NOT NULL DEFAULT 'complete',
  confidence        REAL,
  duration_seconds  INTEGER,
  segments          TEXT NOT NULL DEFAULT '[]',          -- [{speaker,role,start,end,text,sentiment}]
  full_text         TEXT NOT NULL DEFAULT '',
  speakers          TEXT NOT NULL DEFAULT '[]',
  redactions        TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transcripts_call ON transcripts(call_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_org ON transcripts(organization_id);

CREATE TABLE IF NOT EXISTS call_analyses (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id           TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  transcript_id     TEXT REFERENCES transcripts(id) ON DELETE CASCADE,
  lead_id           TEXT,
  model             TEXT NOT NULL,
  provider          TEXT NOT NULL,
  summary           TEXT,
  key_points        TEXT NOT NULL DEFAULT '[]',
  questions         TEXT NOT NULL DEFAULT '[]',
  objections        TEXT NOT NULL DEFAULT '[]',
  buying_signals    TEXT NOT NULL DEFAULT '[]',
  risks             TEXT NOT NULL DEFAULT '[]',
  action_items      TEXT NOT NULL DEFAULT '[]',
  commitments       TEXT NOT NULL DEFAULT '[]',          -- [{party,text,due}]
  next_steps        TEXT NOT NULL DEFAULT '[]',
  topics            TEXT NOT NULL DEFAULT '[]',
  competitors       TEXT NOT NULL DEFAULT '[]',
  sentiment         TEXT,                                -- positive|neutral|negative|mixed
  sentiment_score   REAL,
  talk_ratio        REAL,                                -- agent share of talk time 0..1
  extraction        TEXT NOT NULL DEFAULT '{}',          -- structured CRM fields
  scorecard         TEXT NOT NULL DEFAULT '{}',          -- coaching scores
  coaching          TEXT NOT NULL DEFAULT '{}',
  latency_ms        INTEGER,
  tokens_used       INTEGER,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyses_call ON call_analyses(call_id);
CREATE INDEX IF NOT EXISTS idx_analyses_org ON call_analyses(organization_id, created_at);

-- --------------------------------------------- AI suggestions & approvals ---
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_id          TEXT NOT NULL,
  source_type       TEXT NOT NULL,                       -- call|email|meeting|manual
  source_id         TEXT,
  entity_type       TEXT NOT NULL,                       -- lead|deal|task|meeting
  entity_id         TEXT,
  field             TEXT NOT NULL,
  label             TEXT,
  current_value     TEXT,
  suggested_value   TEXT,
  value_type        TEXT NOT NULL DEFAULT 'string',      -- string|number|date|array|enum
  confidence        REAL NOT NULL DEFAULT 0.5,
  sensitivity       TEXT NOT NULL DEFAULT 'normal',      -- normal|sensitive
  rationale         TEXT,
  evidence          TEXT NOT NULL DEFAULT '[]',          -- transcript quotes
  status            TEXT NOT NULL DEFAULT 'pending',     -- pending|approved|rejected|auto_applied|superseded|edited
  applied_value     TEXT,
  decided_by        TEXT REFERENCES users(id),
  decided_at        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suggestions_batch ON ai_suggestions(batch_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON ai_suggestions(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_suggestions_entity ON ai_suggestions(entity_type, entity_id);

-- ------------------------------------------------------ engagement layer ---
CREATE TABLE IF NOT EXISTS emails (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id           TEXT REFERENCES leads(id) ON DELETE SET NULL,
  deal_id           TEXT REFERENCES deals(id) ON DELETE SET NULL,
  call_id           TEXT REFERENCES calls(id) ON DELETE SET NULL,
  user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  direction         TEXT NOT NULL DEFAULT 'outbound',
  template          TEXT,                                -- thank_you|follow_up|proposal_follow_up|...
  to_address        TEXT,
  cc                TEXT NOT NULL DEFAULT '[]',
  subject           TEXT,
  body              TEXT,
  body_format       TEXT NOT NULL DEFAULT 'text',
  status            TEXT NOT NULL DEFAULT 'draft',       -- draft|queued|sent|failed|received
  generated_by_ai   INTEGER NOT NULL DEFAULT 0,
  ai_metadata       TEXT NOT NULL DEFAULT '{}',
  edited_by_human   INTEGER NOT NULL DEFAULT 0,
  provider          TEXT,
  provider_message_id TEXT,
  opened_at         TEXT,
  replied_at        TEXT,
  sent_at           TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_org ON emails(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_emails_lead ON emails(lead_id);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id           TEXT REFERENCES leads(id) ON DELETE SET NULL,
  user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  channel           TEXT NOT NULL,                       -- sms|whatsapp
  direction         TEXT NOT NULL,
  to_number         TEXT,
  from_number       TEXT,
  body              TEXT,
  status            TEXT NOT NULL DEFAULT 'queued',
  provider          TEXT,
  provider_message_id TEXT,
  consent_basis     TEXT,                                -- opt_in|existing_relationship|blocked
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id);

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id           TEXT REFERENCES leads(id) ON DELETE SET NULL,
  deal_id           TEXT REFERENCES deals(id) ON DELETE SET NULL,
  call_id           TEXT REFERENCES calls(id) ON DELETE SET NULL,
  assignee_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  type              TEXT NOT NULL DEFAULT 'follow_up',   -- call|email|follow_up|demo|proposal|research|meeting
  priority          TEXT NOT NULL DEFAULT 'medium',      -- low|medium|high|urgent
  status            TEXT NOT NULL DEFAULT 'open',        -- open|in_progress|done|cancelled
  due_at            TEXT,
  completed_at      TEXT,
  source            TEXT NOT NULL DEFAULT 'user',        -- user|ai|automation
  ai_reason         TEXT,
  reminder_at       TEXT,
  reminder_sent_at  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(organization_id, assignee_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_lead ON tasks(lead_id);

CREATE TABLE IF NOT EXISTS notes (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id           TEXT REFERENCES leads(id) ON DELETE CASCADE,
  deal_id           TEXT REFERENCES deals(id) ON DELETE SET NULL,
  call_id           TEXT REFERENCES calls(id) ON DELETE SET NULL,
  author_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  body              TEXT NOT NULL,
  pinned            INTEGER NOT NULL DEFAULT 0,
  source            TEXT NOT NULL DEFAULT 'user',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_lead ON notes(lead_id);

CREATE TABLE IF NOT EXISTS meetings (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id           TEXT REFERENCES leads(id) ON DELETE SET NULL,
  deal_id           TEXT REFERENCES deals(id) ON DELETE SET NULL,
  organizer_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  type              TEXT NOT NULL DEFAULT 'meeting',     -- meeting|demo|discovery|follow_up|internal
  location          TEXT,
  conference_url    TEXT,
  starts_at         TEXT NOT NULL,
  ends_at           TEXT NOT NULL,
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  attendees         TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'scheduled',   -- scheduled|held|cancelled|no_show
  reminder_minutes  INTEGER NOT NULL DEFAULT 15,
  reminder_sent_at  TEXT,
  invite_sent_at    TEXT,
  external_calendar TEXT,
  external_event_id TEXT,
  ai_suggested      INTEGER NOT NULL DEFAULT 0,
  outcome_notes     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meetings_org ON meetings(organization_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_meetings_lead ON meetings(lead_id);

-- Unified timeline. Written by services, never edited.
CREATE TABLE IF NOT EXISTS activities (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id           TEXT,
  deal_id           TEXT,
  company_id        TEXT,
  actor_id          TEXT,
  actor_type        TEXT NOT NULL DEFAULT 'user',        -- user|ai|system|automation
  type              TEXT NOT NULL,                       -- call|email|sms|whatsapp|meeting|note|task|crm_change|ai_insight|stage_change
  ref_id            TEXT,
  title             TEXT NOT NULL,
  body              TEXT,
  metadata          TEXT NOT NULL DEFAULT '{}',
  occurred_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_activities_org ON activities(organization_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_activities_deal ON activities(deal_id, occurred_at);

CREATE TABLE IF NOT EXISTS notifications (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,                       -- new_lead|missed_call|follow_up|task|deal|manager_alert|ai_recommendation|meeting
  title             TEXT NOT NULL,
  body              TEXT,
  priority          TEXT NOT NULL DEFAULT 'normal',
  entity_type       TEXT,
  entity_id         TEXT,
  link              TEXT,
  channels          TEXT NOT NULL DEFAULT '["in_app"]',
  read_at           TEXT,
  emailed_at        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at);

-- --------------------------------------------------- governance & config ---
CREATE TABLE IF NOT EXISTS audit_logs (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL,
  actor_id          TEXT,
  actor_type        TEXT NOT NULL DEFAULT 'user',
  actor_label       TEXT,
  action            TEXT NOT NULL,                       -- lead.update, ai.suggestion.approve, ...
  entity_type       TEXT,
  entity_id         TEXT,
  before            TEXT,
  after             TEXT,
  diff              TEXT,
  source            TEXT NOT NULL DEFAULT 'api',         -- api|ui|ai|automation|webhook
  ip                TEXT,
  user_agent        TEXT,
  request_id        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS custom_field_defs (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type       TEXT NOT NULL,                       -- lead|deal|company
  key               TEXT NOT NULL,
  label             TEXT NOT NULL,
  type              TEXT NOT NULL,                       -- text|number|date|select|multiselect|boolean|currency
  options           TEXT NOT NULL DEFAULT '[]',
  required          INTEGER NOT NULL DEFAULT 0,
  ai_extractable    INTEGER NOT NULL DEFAULT 0,
  ai_hint           TEXT,
  position          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  UNIQUE (organization_id, entity_type, key)
);

CREATE TABLE IF NOT EXISTS assignment_rules (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 100,
  conditions        TEXT NOT NULL DEFAULT '[]',          -- [{field,op,value}]
  strategy          TEXT NOT NULL DEFAULT 'round_robin', -- round_robin|specific_user|team_load|least_loaded
  target_user_id    TEXT,
  target_team_id    TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  cursor            INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integrations (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,                       -- google_mail|ms_graph|twilio|slack|hubspot|stripe...
  category          TEXT NOT NULL,                       -- email|calendar|telephony|crm|chat|messaging|payments
  status            TEXT NOT NULL DEFAULT 'disconnected',
  config            TEXT NOT NULL DEFAULT '{}',
  credentials_enc   TEXT,                                -- encrypted at rest
  last_sync_at      TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (organization_id, provider)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url               TEXT NOT NULL,
  events            TEXT NOT NULL DEFAULT '[]',
  secret            TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  failure_count     INTEGER NOT NULL DEFAULT 0,
  last_status       INTEGER,
  last_delivered_at TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL,
  webhook_id        TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event             TEXT NOT NULL,
  payload           TEXT NOT NULL,
  status_code       INTEGER,
  error             TEXT,
  attempt           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL
);

-- ------------------------------------------------------- async processing ---
CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT,
  type              TEXT NOT NULL,
  payload           TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'pending',     -- pending|running|succeeded|failed|dead
  priority          INTEGER NOT NULL DEFAULT 5,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  run_after         TEXT NOT NULL,
  locked_at         TEXT,
  locked_by         TEXT,
  last_error        TEXT,
  result            TEXT,
  started_at        TEXT,
  finished_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_poll ON jobs(status, run_after, priority);

CREATE TABLE IF NOT EXISTS ai_usage (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL,
  user_id           TEXT,
  feature           TEXT NOT NULL,                       -- transcription|analysis|email|assistant|insights
  provider          TEXT NOT NULL,
  model             TEXT,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER,
  success           INTEGER NOT NULL DEFAULT 1,
  error             TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aiusage_org ON ai_usage(organization_id, created_at);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  title             TEXT,
  messages          TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aiconv_user ON ai_conversations(user_id, updated_at);

-- ------------------------------------------------------------- full text ---
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  organization_id UNINDEXED,
  entity_type     UNINDEXED,
  entity_id       UNINDEXED,
  owner_id        UNINDEXED,
  lead_id         UNINDEXED,
  occurred_at     UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61'
);
