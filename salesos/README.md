# SalesOS

**An AI sales operating system.** Agents call from one screen; the transcript,
summary, objections, buying signals, next steps and the CRM updates are waiting
for them when they hang up.

The differentiator is not "a CRM with an AI button". It is that every customer
conversation automatically becomes structured sales intelligence — and that the
organisation, not the model, decides how much of that lands in the CRM without a
human looking at it.

```
Lead → Call → Recording → Transcript → AI analysis → CRM suggestions
     → Agent approves → CRM updated → Follow-up email → Task → Reminder → Pipeline moved
```

Every step of that chain is implemented and exercised by the test suite.

---

## Quick start

```bash
cd salesos
npm install
npm run dev
```

Open **http://localhost:5173**. The database is seeded automatically on first
run with a full demo organisation: 10 users, 64 leads, 44 deals, ~100 calls with
real transcripts and analyses, plus tasks, emails, meetings and an audit trail.

| Sign in as | Email | Password |
| --- | --- | --- |
| Sales Agent | `agent@northstar.demo` | `Demo1234!` |
| Sales Manager | `manager@northstar.demo` | `Demo1234!` |
| Admin | `admin@northstar.demo` | `Demo1234!` |
| Super Admin | `owner@northstar.demo` | `Demo1234!` |

**No API keys are required.** With no model configured, a built-in deterministic
engine handles transcription, analysis, extraction and email drafting through the
same interfaces a model uses, so the whole product is usable offline. Set
`ANTHROPIC_API_KEY` to switch to model-backed analysis — nothing else changes.

```bash
npm test          # 92 server tests
npm run build     # production build of the web client
npm start         # single process serving the API and the built client
npm run reset     # rebuild the demo dataset
```

---

## What is built

### The core loop
- **Integrated calling** — click-to-call, inbound with CRM screen-pop, hold,
  mute, transfer, DTMF, voicemail, missed-call tracking, number masking,
  international dialling, and per-region recording-consent capture.
- **Transcription with speaker identification**, PII redaction, and full-text
  search inside any transcript.
- **Conversation analysis** — summary, key points, customer questions,
  objections (categorised, with severity and whether they were handled), buying
  signals, risks, commitments by both parties, action items, next steps,
  sentiment and talk ratio.
- **AI → CRM extraction** — budget, timeline, decision maker, competitors, pain
  points, requirements, deal stage, expected value, lead temperature, follow-up
  date and next action, each with a confidence score and the transcript quote it
  came from.
- **An approval queue** where the agent sees exactly what will change, from what
  to what, why, and how sure the model is — then approves, edits or rejects.
- **AI email generation** with eight templates, grounded in the actual call, in a
  Generate → Edit → Preview → Send flow that logs the result to the CRM and
  records whether a human edited the draft.
- **Follow-up automation** — proposed tasks with dates derived from what was
  agreed, created only after approval (or automatically, if the org opts in).

### Around it
Agent dashboard · manager dashboard · admin panel · lead and contact CRM with
CSV/Excel import, duplicate detection, bulk actions and custom fields ·
drag-and-drop pipeline with deal-risk scoring · conversation feed · call quality
scorecards and coaching · AI sales intelligence (who converts, what is slipping,
which objections cost deals, why deals are lost) · a persistent AI assistant ·
global and natural-language search · analytics with CSV/PDF export · unified
activity timeline · calendar and meetings · notifications · RBAC · audit logs ·
integrations framework · REST API · signed webhooks · responsive mobile layout ·
dark and light themes.

See [`docs/FEATURES.md`](docs/FEATURES.md) for the full deliverable-by-deliverable map.

---

## Architecture

```
salesos/
├── server/            Node.js + Express API (no ORM, no build step)
│   ├── src/db/        schema.sql, migrations, demo seeder
│   ├── src/lib/       crypto, validation, RBAC, phone, constants, time
│   ├── src/middleware auth, RBAC, rate limiting, error handling
│   ├── src/services/  the domain: ai, telephony, email, storage, queue,
│   │                  search, automation, notifications, audit, crm
│   ├── src/routes/    thin HTTP layer over the services
│   └── test/          92 tests over the real app and a real database
└── web/               React + Vite SPA
    ├── src/components design system, charts, call dock, assistant, palette
    ├── src/lib/       API client, auth, realtime (SSE), hooks, formatting
    └── src/pages/     one file per screen
```

Design decisions worth knowing:

- **SQLite via `node:sqlite`.** Zero-install, real SQL, real transactions, and
  FTS5 for search. The data layer is plain SQL, so moving to Postgres is a
  driver swap rather than a rewrite.
- **Every service is provider-abstracted.** Telephony, email, storage, speech-to-text
  and the language model each sit behind an interface with a working default
  implementation, so Twilio, Gmail, S3, Whisper or Claude drop in without
  touching call handling or the CRM.
- **A durable job queue in the primary database.** Transcription and analysis are
  slow and failure-prone, so they run as separate retryable jobs
  (`process_recording → transcribe → analyse`). A restart mid-analysis resumes
  rather than losing the work.
- **Organisation isolation is structural.** `req.auth` from the verified token is
  the only source of organisation identity; nothing reads it from a body or query
  string. Record-level scope (own / team / org) is applied in the data layer, not
  in the UI.
- **The audit trail is not optional.** Every mutation that matters — including
  every AI-applied field change — is written with before/after snapshots, the
  actor type (`user` / `ai` / `system` / `automation`), and the evidence.

Deeper detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
API reference: [`docs/API.md`](docs/API.md) ·
Security and compliance posture: [`docs/SECURITY.md`](docs/SECURITY.md)

---

## The product principle, in code

> AI should reduce manual CRM work rather than create more work. But important
> CRM changes should have configurable approval rules.

That is a setting, not a slogan — `crmApproval` on the organisation:

```jsonc
{
  "mode": "suggest",                     // "suggest" | "auto"
  "autoApplyConfidenceThreshold": 0.85,  // only used in auto mode
  "alwaysReviewSensitive": true,         // deal value, stage, close date, email
  "autoCreateTasks": false               // follow-up tasks without asking
}
```

In `suggest` mode nothing reaches the CRM until someone approves it. In `auto`
mode high-confidence, non-sensitive changes apply the moment analysis completes —
and sensitive fields still queue for a human unless a super admin explicitly
turns that protection off. Either way every change is audited and reversible, and
the agent can see the transcript quote behind it.

---

## Configuration

Everything has a working default in development. Copy `.env.example` to `.env` to
change any of it. The values that matter in production:

| Variable | Why |
| --- | --- |
| `JWT_SECRET`, `ENCRYPTION_KEY` | **Required in production** — the process refuses to start without them rather than generating weak keys silently. |
| `ANTHROPIC_API_KEY` | Switches AI features from the built-in engine to model-backed analysis. |
| `TELEPHONY_PROVIDER` | `simulator` (default) or `twilio`. |
| `EMAIL_PROVIDER` | `log` (default), `smtp`, `google`, `microsoft`. |
| `STORAGE_DRIVER` | `local` (default, AES-256-GCM at rest) or `s3`. |
| `DATABASE_FILE` | SQLite path. |

## Notes on the demo data

The simulator generates a synthetic sales conversation per call, deterministically
seeded from the call id, and then runs the **real** analysis pipeline over it —
the summaries, objections, scores and CRM suggestions in the demo are produced by
the same code that runs in production, not fixtures. Transcripts produced this
way are labelled `local` on every record so they are never mistaken for real
audio.
