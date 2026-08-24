# Architecture

SalesOS is a two-process application: a Node.js API and a React SPA. In
production both are served by the single API process (the built client is served
as static files with an SPA fallback), so the deployment unit is one container
plus a database and an object store.

```
                       ┌──────────────────────────────────────────┐
   Browser ── HTTPS ──▶ │  Express API                             │
             SSE  ◀──── │  routes → services → SQL                 │
                       │                                          │
                       │  ┌────────────┐   ┌──────────────────┐    │
                       │  │ job queue  │──▶│ workers          │    │
                       │  │ (in DB)    │   │ recording→STT→AI │    │
                       │  └────────────┘   └──────────────────┘    │
                       └───────┬───────────────────┬──────────────┘
                               │                   │
                    ┌──────────▼─────┐   ┌─────────▼──────────┐
                    │ SQLite + FTS5  │   │ object storage     │
                    │ (CRM + audit)  │   │ (recordings, AES)  │
                    └────────────────┘   └────────────────────┘
                               │
        ┌──────────────────────┼───────────────────────┐
        ▼                      ▼                       ▼
  telephony provider    email provider          model provider
  (simulator/Twilio)    (log/SMTP/Gmail/Graph)  (built-in/Claude)
```

## Layering

**`routes/`** is thin. A handler validates input, checks the permission, calls a
service, and shapes the response. It contains no business rules, because a rule
that lives in a route is a rule that does not apply to the queue, the seeder or
the next entry point.

**`services/`** is the domain. `crm`, `telephony`, `ai`, `automation`,
`notifications`, `audit`, `search`, `queue`, `storage`, `email`, `webhooks`, `org`.
Each owns its invariants: `crm.createLead` always dedupes, always assigns, always
writes the timeline entry and always indexes for search — whether it was called
by an HTTP request, a CSV import or a background job.

**`lib/`** is dependency-free utility: crypto, validation, RBAC tables, phone
normalisation, domain constants, time arithmetic.

**`db/`** is plain SQL. No ORM, no query builder. `schema.sql` is the single
source of truth for the data model and is applied idempotently at boot.

## The post-call pipeline

The most important flow in the product, and the reason the queue exists:

| Step | Job | What it does | If it fails |
| --- | --- | --- | --- |
| 1 | `call.process_recording` | Fetches the recording from the provider, encrypts it, stores it | Retries; the call row still has its disposition |
| 2 | `call.transcribe` | Speech-to-text, diarisation, PII redaction, search indexing | Retries; the recording is already safe |
| 3 | `call.analyse` | Summary, objections, signals, coaching, CRM extraction, suggestions, follow-up proposals | Retries; the transcript is already stored |

Splitting the chain into three jobs rather than one long task means each step has
its own retry budget with exponential backoff, a transcription outage never loses
a recording, and the agent watches progress step by step over SSE
(`call.ai_status` → `transcript.ready` → `analysis.ready`).

The queue is a table with an atomic claim (`UPDATE … WHERE status='pending'`), so
multiple workers never take the same job, and jobs abandoned by a crashed process
are recovered on the next boot. Swapping in Redis or SQS changes one function.

## The AI service layer

```
services/ai/
├── index.js              facade: transcribeCall, analyseCall, generateEmail, usage
├── prompts.js            every prompt and tool schema, versioned
├── provider.anthropic.js Messages API over fetch; tool use for structured output
├── local-engine.js       deterministic analysis engine (the reference contract)
├── transcription.js      external STT adapter + synthetic engine for the simulator
├── email-writer.js       deterministic email drafting
├── extraction.js         analysis → CRM suggestions → apply/reject with audit
├── insights.js           conversion, risk, objection, win/loss, agent performance
└── assistant.js          permission-scoped tools + tool-use loop + intent router
```

Two rules hold this together:

1. **One contract, two implementations.** `local-engine.analyseTranscript()` and
   the model's `record_call_analysis` tool return the same object shape. Every
   consumer downstream — extraction, coaching, email drafting, the UI — is
   provider-agnostic. Losing the model degrades quality, never availability: a
   failed or rate-limited call falls back to the local engine and is metered as
   `local-fallback`.
2. **Permissions live in the tools, not the prompt.** The assistant answers only
   by calling data tools, and each tool applies the caller's visibility scope
   before returning anything. An agent asking "who is performing best?" is not
   refused by instruction — the `agent_performance` tool is not in their tool
   list at all. That is why prompt injection cannot widen access here.

## Access control

Two independent dimensions, both enforced server-side:

- **Capability** — `can(role, permission)` over an explicit permission table
  (`lib/permissions.js`). The UI renders from the permission list the server
  computed, never from the role name.
- **Visibility** — `own` (agent), `team` (manager), `org` (admin). Applied as SQL
  (`ownerScopeClause`) on list queries and as an assertion
  (`assertRecordAccess`) on reads and writes by id.

Organisation isolation is separate and unconditional: `organization_id` comes
from the verified token and is a predicate on every query. No endpoint accepts an
organisation id as input.

## Realtime

Server-Sent Events, not WebSockets: every payload here is server → client, SSE
survives proxies, reconnects on its own, and needs no dependency. The hub keys
connections by organisation and user, so a tenant cannot receive another tenant's
stream and per-user notifications are addressable. The client owns one connection
and multiplexes named events with exponential-backoff reconnect.

## Search

FTS5 over a projection table (`search_index`) carrying title, body and the
metadata needed for permission filtering. Records are indexed as they change;
`reindexOrganization` rebuilds from scratch.

Natural-language search is a parser, not a model call: `parseNaturalQuery` pulls
temperature, status, stage, date range, ownership and topic out of a sentence and
hands the residual words to FTS. "hot leads I spoke with last week who mentioned
pricing concerns" becomes `temperature=hot`, `since=-14d`, `ownerId=me`,
`topics=[pricing]`, `entityTypes=[lead, call, transcript]` — fast, free, and
explainable in the UI.

## Frontend

React + Vite, React Router, and no other runtime dependency. Charts are
hand-rolled SVG so they inherit the theme tokens and print correctly; drag-and-drop
is the native HTML5 API with a keyboard-accessible stage selector on every card.
State is request/response through a small `useApi` hook with cancellation —
there is no client-side cache to invalidate, because the SSE stream tells the app
when to refetch.

The call dock lives in the app shell rather than on a page, so navigating during a
live call never interrupts it.

## Scaling path

| Today | Next |
| --- | --- |
| SQLite | Postgres — the data layer is plain SQL |
| In-process queue | Redis/SQS — only `claim()` changes |
| Local encrypted object store | S3 — the driver interface already exists |
| In-process rate limiter | Redis — same middleware interface |
| SSE from one node | Redis pub/sub fan-out behind the same hub API |
| FTS5 | OpenSearch — `search/index.js` is the only caller |
