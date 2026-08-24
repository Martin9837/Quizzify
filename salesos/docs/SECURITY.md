# Security and compliance

## Identity

- **Passwords** are stored as scrypt hashes (N=16384, r=8, p=1, 64-byte key) with a
  per-password salt. The plaintext is never written anywhere, and a failed login
  returns the same message as an unknown account so the endpoint cannot be used to
  enumerate users.
- **Access tokens** are HS256 JWTs, 12 hours by default, carrying only the user id,
  organisation id, role and email.
- **Refresh tokens** are opaque random values stored as SHA-256 hashes and rotated on
  every use: presenting one revokes it and issues a new pair, so a stolen refresh
  token is usable at most once. Changing a password revokes every other session.
- **API keys** are shown once, stored as SHA-256 hashes, matched by an 8-character
  prefix, and recorded in the audit trail as a distinct actor type.
- Suspending a user signs them out everywhere. The last active administrator cannot be
  demoted or suspended.

## Authorisation

Three independent checks, all server-side:

1. **Organisation isolation.** `organization_id` comes from the verified token and is a
   predicate on every query. No endpoint accepts an organisation id as input, so
   cross-tenant access is structurally impossible rather than merely blocked.
2. **Capability.** `can(role, permission)` against an explicit permission table. The
   UI renders from the permission list the server computed, never from the role name.
3. **Record visibility.** `own` (agent) / `team` (manager) / `org` (admin), applied as
   SQL on list queries and as an assertion on reads and writes by id — including the
   AI suggestion queue, so an agent cannot see or approve a change to another agent's
   record, and including search, so no record leaks through a query.

Sensitive operations need more than a role: enabling fully automatic CRM updates or
changing data retention requires a super admin, and only a super admin can grant the
super-admin role.

The AI assistant deserves a specific note. It answers only by calling data tools, and
each tool applies the caller's visibility scope before returning anything. An agent
asking "which agents are performing best?" is not refused by instruction — the tool is
absent from their tool list. Prompt injection cannot widen access because the prompt is
not what grants it.

## Data protection

| Data | At rest | Notes |
| --- | --- | --- |
| Integration credentials | AES-256-GCM | Never returned by the API; responses expose only `hasCredentials` |
| Call recordings | AES-256-GCM (optional, default on) | Streamed through the API so every access is authorised and audited |
| Transcripts | Plain text | Card, SSN and IBAN patterns redacted before storage |
| Passwords / refresh tokens / API keys | One-way hash | Never recoverable |

Secrets are required in production: the process refuses to start without `JWT_SECRET`
and `ENCRYPTION_KEY` rather than silently generating weak ones.

## Call recording and consent

Recording law varies by jurisdiction, so the behaviour is configuration, not a
hard-coded default:

- `consentMode`: `all_party` (default), `one_party`, or `disabled`.
- Per-region overrides keyed by country or region code, so a US-California call can
  require all-party consent while a UK call does not.
- In an all-party region the agent is prompted to capture consent before recording
  starts. The decision is written to the call record and to the contact, with the
  method (`verbal`, `announcement`, `written`, `policy`).
- A call is recorded only when the organisation allows it, the agent requested it, and
  consent is either not required or already on file.
- Denied consent disables recording for that call and blocks playback.
- `do_not_call` blocks outbound dialling and messaging outright — and the AI never
  recommends a flagged contact for a call.

SMS and WhatsApp carry a recorded `consent_basis` (`opt_in`,
`existing_relationship`, `blocked`) on every message, so an audit can reconstruct why
the organisation believed it was permitted to send.

## Auditability

Every mutation that matters is appended to `audit_logs` with:

- the actor and actor **type** — `user`, `ai`, `system` or `automation`
- before/after snapshots and a computed field-level diff
- the source (`ui`, `api`, `ai`, `automation`, `webhook`), IP, user agent, request id

That includes every AI-applied CRM change, whether a human approved it or policy
applied it automatically, alongside the confidence and the transcript quote behind it.
Secret-bearing fields are redacted in the snapshots. Recording deletions and access are
both logged.

## Retention

Per-organisation windows for recordings, transcripts, activity and audit entries. A
scheduled sweep deletes anything past its window — including the recording objects
themselves, not just the database reference — and writes an audit entry for each
deletion. Only a super admin can change a retention window.

## Transport and application hardening

- `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy`, `Cross-Origin-Resource-Policy` on every response.
- CORS is restricted to configured origins plus the app's own origin; a disallowed
  origin simply receives no CORS headers rather than a 500.
- Rate limiting per identity, with a much tighter budget on authentication.
- Every input passes a declarative validator that drops unknown keys, so handlers
  receive exactly the shape they declared.
- All SQL is parameterised. The only identifiers ever interpolated are whitelisted
  (for example `sort` is checked against an allow-list and rejected otherwise).
- Client errors return their message; anything else returns a generic message and logs
  the detail, so internals never leak to a caller.
- Logs redact password, token, secret, key and credential fields.

## What is deliberately not built

Honest gaps, so nobody assumes otherwise:

- **MFA** is a settable policy flag but there is no enrolment flow behind it.
- **SSO/SAML** is not implemented.
- **Field-level encryption** covers credentials and recordings, not arbitrary CRM
  columns.
- **The IP allowlist** is stored but not yet enforced at the edge.
- Single-node deployment assumptions: the rate limiter and job queue are in-process
  (see `ARCHITECTURE.md` for the scaling path).
