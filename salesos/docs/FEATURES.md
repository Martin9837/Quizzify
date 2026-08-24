# Deliverables map

Each requested capability, and where it lives. "Framework" means the interface and a
working default implementation are in place, with a named provider adapter to swap in.

## 1–2. Core objective and roles

Four roles with distinct permissions and dashboards: **Sales Agent**, **Sales
Manager**, **Admin**, **Super Admin**. Permissions are an explicit table
(`lib/permissions.js`), visibility is `own` / `team` / `org`, and both are enforced
server-side. `admin/users` shows the full role-to-permission matrix.

## 3. Sales agent dashboard

`web/src/pages/Dashboard.jsx` → `GET /analytics/dashboard`.

Today's calls, connect rate, talk time, calls missed, follow-ups pending and overdue,
new/hot/warm/cold lead counts, uncontacted leads, tasks due today, deals in progress,
pipeline value and weighted forecast, quota attainment, recent conversations with AI
summaries, and the AI-ranked "who to call today" list with a reason per entry.
Quick actions: Call Lead · Add Lead · Send Email · Schedule Follow-up · Add Note ·
Update Deal, plus an Ask-AI shortcut.

## 4. Lead and contact management

Every requested field including custom fields. CSV/Excel-export import with loose
header matching (`Company`/`Organisation`/`Account` all map correctly) and unmapped
columns preserved as custom fields; a preview pass reports per-row problems and
in-file duplicates before writing. Duplicate detection by email, then normalised
phone, then a name+company fingerprint. Bulk assign / update / archive / tag / untag.
Search, filter, sort, facet counts. Assignment rules with round-robin, specific-user,
team-load and least-loaded strategies.

## 5. Built-in calling

`services/telephony` + `web/src/components/CallDock.jsx`.

Click-to-call, inbound with CRM screen-pop, call history, duration and talk time,
recording with consent controls, status tracking, hold, mute, transfer, DTMF,
voicemail, missed-call tracking with automatic call-back task, automatic CRM
association by number, number masking, international dialling (24 dialling codes),
call notes and dispositions. The contact's CRM profile — last conversation summary,
open tasks, notes, recent activity — is visible during the call, and the dock lives in
the app shell so navigating never drops the call.

Providers: `simulator` (default, fully functional) and `twilio`.

## 6. AI call transcription

`services/ai/transcription.js` → `services/queue/workers.js`.

After an eligible call: fetch the recording, encrypt and store it, transcribe with
speaker identification, redact PII, index for search, then analyse. Displayed as
Transcript · Summary · Key Points · Objections · Buying Signals · Action Items ·
Sentiment · Next Steps, with in-transcript search and highlight.

Engines: `local` (synthetic, for simulator calls) and any external STT endpoint via
`STT_URL`.

## 7. AI-powered CRM updates

`services/ai/extraction.js` — the centrepiece.

Extracts customer interest, product discussed, budget, timeline, decision maker,
competitors, pain points, requirements, follow-up date, deal stage, expected value,
sentiment and next action. Each candidate change carries a confidence score, a
rationale, and the verbatim transcript quote behind it.

The **AI Suggested Updates** panel shows old → new per field with Approve · Edit ·
Reject and Approve All / Reject All. Money, stage and close-date changes are marked
sensitive and separated visually. Every applied change — approved or automatic — is
written to the audit trail and the contact timeline.

## 8. AI email generator

Eight templates (thank-you, follow-up, proposal follow-up, meeting confirmation,
product information, re-engagement, objection response, custom) in a
Generate → Edit → Preview → Send flow. Drafts are grounded in the call: the objection
raised, the commitment made, the date agreed. Sending logs the email against the lead,
deal and call, and records whether a human edited the draft — the number that tells you
whether AI drafting is actually working.

## 9. AI follow-up automation

`services/automation/index.js`. Action items become dated task proposals with a
priority and the reason from the conversation. Nothing is created until the agent
accepts, unless the organisation enables `autoCreateTasks`. Reminders fire in-app and
by email through the queue.

## 10. Deal and pipeline management

Nine stages, drag-and-drop with a keyboard-accessible stage selector on every card,
persisted ordering, and a lost-reason requirement before a deal can be marked lost.
Each deal shows value, probability, weighted value, close date, owner, calls, emails,
tasks, notes, stage-velocity history and AI risk insight.

## 11. AI sales intelligence

`services/ai/insights.js`. Which leads convert (with the contributing factors), which
deals are at risk (with reasons and a recommended action), who has not been contacted,
which objections recur and how often they go unhandled, who is performing best, why
deals are lost, and who to call today. Plus an Ask-AI interface over the same data.

## 12. Manager dashboard

Team performance, calls per agent, talk time, connect and conversion rates, revenue,
pipeline, won/lost, follow-up completion, lead response time, agent activity, call
quality scores and AI conversation insights. Filter by agent, team and period.

## 13. Call quality and coaching

Eight scored dimensions — opening, discovery, product knowledge, objection handling,
listening, engagement, closing, next-step confirmation — producing a weighted call
score with strengths, improvements and missed opportunities. Managers get per-agent
trends, objection-handling rates by category, recurring coaching priorities, and the
lowest-scoring calls surfaced first for review.

## 14. Communication hub

One `activities` timeline for calls, emails, SMS/WhatsApp, meetings, notes, tasks, CRM
changes, stage moves and AI insights, attached to the lead, deal and company, with the
actor type visible on each entry.

## 15. Calendar and meetings

Week grid plus agenda, meeting creation with attendees and conference link,
invitations sent through the email pipeline, reminders, held/no-show outcomes, and
AI-suggested times computed from real calendar load.

## 16. Notifications

New lead, missed call, follow-up due, task reminder, deal update, manager alert, AI
recommendation, meeting reminder, approval required. In-app over SSE, email through the
queue, with a daily digest.

## 17. Search

Global full-text search over leads, contacts, companies, deals, calls, transcripts,
emails, tasks and notes. Natural-language search parses temperature, status, stage,
date range, ownership and topic out of a sentence — "show me all hot leads I spoke with
last week who mentioned pricing concerns" — and shows its interpretation.

## 18. Analytics and reports

Sales performance, conversion funnel (measured on stages *reached*, not current
occupancy), revenue, calls, lead sources, agent performance, deal velocity, win/loss,
follow-up performance and AI call insights. CSV export from the same endpoint that
renders the screen; print-to-PDF stylesheet included.

## 19. Admin panel

Users, roles and permissions, teams, lead assignment rules, custom CRM fields (with an
AI-extraction hint per field), call and recording settings with regional consent
overrides, email settings, AI settings including the approval policy, integrations,
billing and usage, audit log, security and retention, system and queue health.

## 20. Integrations

Framework with thirteen catalogued providers across email, calendar, telephony, CRM,
chat, messaging and payments. Credentials are AES-256-GCM encrypted and never
returned. Working adapters: Twilio (voice), Gmail and Microsoft Graph (email), SMTP,
local and S3-shaped object storage. Plus signed outbound webhooks, inbound provider
webhooks, and a REST API with API-key auth.

## 21. AI assistant

Persistent, reachable from every screen and from the command palette. Answers "who
should I call today", "summarise my last conversation with X", "draft a follow-up
email", "which deals are likely to close", "show customers not contacted in 14 days".
Every answer comes from permission-scoped tools, so it can only ever see what the
current user may see.

## 22. UX/UI

Search-first navigation with a command palette (⌘K), keyboard shortcuts, minimal-click
quick actions, responsive down to 414px with no horizontal scroll, dark and light
themes plus a system option, a deliberately simple call screen, real-time updates over
SSE, focus-visible outlines, focus-trapped dialogs, ARIA labelling, reduced-motion
support, and text alternatives for every chart.

## 23. Automation workflow

The full chain is implemented and covered by tests:

```
Lead → Call → Recording → Transcript → Analysis → CRM suggestions → Approval
     → CRM updated → Email drafted → Reviewed → Sent → Task created → Reminder → Pipeline moved
```

## 24. Security and compliance

See [`SECURITY.md`](SECURITY.md), including what is deliberately not built.

## 25. Technical requirements

Modular services, validated APIs, SSE realtime, a durable job queue for background
transcription and AI, a provider-abstracted AI layer, SQL database, encrypted object
storage, FTS5 search, webhook framework, uniform error handling, structured logging
with secret redaction, and health/queue/AI-usage observability.

## 26. Product principle

`crmApproval` is an organisation setting, not a slogan: `suggest` (nothing applies
without a human) or `auto` (high-confidence, non-sensitive changes apply immediately),
with `alwaysReviewSensitive` protecting money, stage and dates, and everything audited
either way.

## 27. Verification

- **96 server tests** over the real Express app and a real database, covering auth,
  RBAC, cross-agent isolation, CRM rules, import, the calling state machine, the full
  AI pipeline, extraction accuracy, the approval workflow, assistant permissions,
  search parsing, analytics integrity and cryptography.
- **41 browser checks** in Chromium over every page, the live call dock, transcript
  search, the AI assistant, the command palette, dark mode, mobile layout, and
  role-based access — asserting zero console errors and zero failed API calls.
