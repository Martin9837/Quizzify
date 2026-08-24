# API reference

Base URL `/api/v1`. All responses are JSON. All times are ISO-8601 UTC.

## Authentication

```http
POST /api/v1/auth/login
{ "email": "agent@northstar.demo", "password": "Demo1234!" }
```

Returns an access token (12h) and a refresh token (30d):

```jsonc
{
  "accessToken": "eyJ…",
  "refreshToken": "…",
  "expiresIn": 43200,
  "user": { "id": "user_…", "role": "agent", "permissions": ["call:place", "…"] },
  "organization": { "id": "org_…", "settings": { … } }
}
```

Send the access token on every request:

```http
Authorization: Bearer <accessToken>
```

`POST /auth/refresh` rotates the pair — the presented refresh token is revoked, so a
stolen one is usable at most once. Server-to-server callers send `x-api-key: sos_…`
instead; API keys act with admin authority inside their organisation and are recorded
separately in the audit log.

Errors are uniform:

```jsonc
{
  "error": { "code": "unprocessable", "message": "Validation failed", "details": [ { "field": "email", "message": "has an invalid format" } ] },
  "requestId": "req_mt6m…"
}
```

`400 bad_request` · `401 unauthorized` · `403 forbidden` · `404 not_found` ·
`409 conflict` · `422 unprocessable` · `429 rate_limited` · `5xx internal_error`.
The `requestId` also comes back as the `x-request-id` header and appears in the logs.

---

## Reference data

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/meta` | Pipeline stages, enums, templates, roles, providers. No auth required. |
| GET | `/health` | Liveness plus database and queue state. |

## Leads

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/leads` | `q, status, temperature, source, industry, ownerId, minScore, tag, followUpBefore, notContactedSince, sort, limit, offset` |
| GET | `/leads/facets` | Filter values with counts, scoped to the caller |
| POST | `/leads` | `409` with `details.duplicateOf` on a duplicate; `?allowDuplicate=true` to override |
| POST | `/leads/check-duplicate` | Pre-flight duplicate check for a form |
| POST | `/leads/import` | `csv` text or `rows[]`; over 500 rows returns `202` and queues |
| POST | `/leads/import/preview` | Header mapping and per-row problems, no writes |
| POST | `/leads/bulk` | `assign`, `update`, `archive`, `tag`, `untag` |
| GET | `/leads/:id` | Lead, deals, calls, tasks, emails, meetings, notes, pending AI suggestions |
| PATCH | `/leads/:id` | Reassignment requires `lead:assign` |
| DELETE | `/leads/:id` | Archive (retained for reporting and audit) |
| GET | `/leads/:id/timeline` | Unified activity feed |
| GET | `/leads/:id/audit` | Field-level change history |
| POST | `/leads/:id/follow-up` | Sets the follow-up date and optionally creates the task |

## Deals

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/deals/pipeline` | Board grouped by stage, with per-deal risk assessment and totals |
| GET/POST | `/deals` | List and create |
| GET/PATCH | `/deals/:id` | Detail includes contact, risk, stage history, activity, AI suggestions |
| POST | `/deals/:id/move` | Drag-and-drop; `422 lost_reason_required` when moving to `lost` without a reason |
| POST | `/deals/reorder` | Persist card order within a stage |
| GET | `/deals/:id/velocity` | Days spent in each stage, and whether a human or the AI moved it |

## Calling

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/calls` | `status, direction, outcome, leadId, agentId, since, until, hasRecording, analysed` |
| GET | `/calls/active` | Restores the call dock after a reload |
| GET | `/calls/consent-policy` | Resolved consent obligation for a destination, before dialling |
| POST | `/calls` | Click-to-call. Returns the call, consent policy, lead and CRM context |
| POST | `/calls/:id/answer` · `/hold` · `/mute` · `/transfer` · `/dtmf` | In-call controls |
| POST | `/calls/:id/consent` | Record the consent decision captured on the call |
| POST | `/calls/:id/end` | Disposition and notes; returns `pipelineQueued` and `skipReason` |
| POST | `/calls/inbound` | Inbound call with CRM matching (also drives the simulator) |
| GET | `/calls/:id/recording` | Streams through the API so access is always checked and audited |
| DELETE | `/calls/:id/recording` | Honour a deletion request; audited |

## Conversation intelligence

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/conversations` | Analysed calls; filter by `sentiment`, `objection`, `minScore`, `agentId` |
| GET | `/conversations/:callId` | Call, transcript, analysis, suggestions, emails, tasks |
| GET | `/conversations/:callId/transcript/search` | In-transcript search with highlight offsets |
| POST | `/conversations/:callId/reanalyse` | Re-run with the current model and prompt |
| POST | `/conversations/:callId/process` | Run the pipeline for a call that skipped it |

## AI

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/ai/status` | Active provider, model, prompt version, org AI settings |
| POST | `/ai/ask` | Assistant. Returns the answer, the tools used, and the tools available to this user |
| GET | `/ai/insights` | Conversion ranking, deal risk, stale leads, objection trends, win/loss |
| GET | `/ai/call-list` | Ranked call list with a reason per entry |
| GET | `/ai/suggestions` | Pending CRM changes, grouped by conversation. Scoped to the caller's records |
| POST | `/ai/suggestions/:id/decide` | `approve` · `reject` · `edit` (with `value`) |
| POST | `/ai/suggestions/batch/:batchId/decide` | Approve all / reject all |
| POST | `/ai/email/generate` | Draft grounded in a call, a lead, or explicit instructions |
| POST | `/ai/follow-ups/propose` | Proposed tasks — creates nothing |
| POST | `/ai/follow-ups/accept` | Create the approved subset |
| GET | `/ai/usage` | Requests, tokens, latency and failures per feature |
| GET | `/ai/meeting-slots` | Suggested times from real calendar load |

## Engagement

`/emails` (draft → send, with `generatedByAi` and `editedByHuman` recorded) ·
`/messages` (SMS/WhatsApp with a recorded consent basis) · `/tasks` · `/notes` ·
`/meetings` (+ `/meetings/slots/suggest`) · `/activities` · `/notifications`.

## Search

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/search?q=` | Full text across nine entity types, grouped, every hit linkable |
| POST | `/search/natural` | Sentence in, `interpretation` + results out |
| GET | `/search/suggest?q=` | Command-palette typeahead |

## Analytics

`/analytics/dashboard` (agent) · `/analytics/team` (manager) · `/analytics/funnel` ·
`/analytics/reports` (catalogue) · `/analytics/reports/:report?format=csv` ·
`/coaching/overview` · `/coaching/calls` · `/coaching/agents/:id`.

## Admin

`/admin/users` · `/teams` · `/custom-fields` · `/assignment-rules` · `/settings` ·
`/organization` · `/integrations` · `/webhooks` · `/api-keys` · `/audit` · `/system` ·
`/billing` · `/permissions` · `/reindex` · `/jobs/:id/retry`.

---

## Realtime

```js
const events = new EventSource(`/api/v1/events?access_token=${token}`);
events.addEventListener('analysis.ready', (event) => { /* … */ });
```

`connected` · `activity.created` · `notification.created` · `notification.read` ·
`call.started` · `call.answered` · `call.updated` · `call.ended` · `call.incoming` ·
`call.ai_status` · `transcript.ready` · `analysis.ready` · `ai.suggestions.ready` ·
`email.sent` · `manager.alert` · `import.complete`.

Streams are keyed by organisation and user: a tenant can never receive another
tenant's events.

## Outbound webhooks

Configure endpoints under `/admin/webhooks`. Delivery is queued and retried with
backoff; an endpoint that fails 20 times is disabled automatically.

```http
POST https://your-endpoint
X-SalesOS-Event: analysis.ready
X-SalesOS-Signature: t=1767225600,v1=<hmac-sha256>
```

Verify with `HMAC_SHA256(secret, "<timestamp>.<rawBody>")` and reject a timestamp
that is not recent. Events: `lead.created` `lead.updated` `lead.assigned`
`deal.created` `deal.stage_changed` `deal.won` `deal.lost` `call.started`
`call.completed` `call.missed` `transcript.ready` `analysis.ready` `email.sent`
`task.created` `task.completed` `meeting.scheduled` `ai.suggestions.ready`.

## Inbound webhooks

`/webhooks/telephony/status` · `/telephony/recording` · `/telephony/inbound` ·
`/email/events`. These authenticate by provider signature rather than JWT — Twilio
requests are verified against `TWILIO_AUTH_TOKEN`.

## Rate limits

600 requests/minute per identity by default; 20/minute on authentication; 60/minute
on the AI assistant. Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset`, and `Retry-After` on a 429.
