# Putting the SalesOS API on Cloudflare

The short version: **a Durable Object is the only place on Cloudflare this
server can run without rewriting its data layer**, and it works. Everything in
this directory is a runnable proof of that, not a design document.

## Why this is not a Workers app, and is a Durable Object app

The API keeps its database in a local SQLite file and reaches it through 478
*synchronous* calls across 36 files. Anything that makes those calls
asynchronous cascades: 99 exported service functions change signature, and the
21 routers above them follow.

| | Local SQLite | Synchronous SQL | FTS5 | Keeps a process alive |
| --- | --- | --- | --- | --- |
| Workers alone | `node:sqlite` is a non-functional stub | — | — | no |
| Workers + D1 | no | **no** — every method is awaited | yes | no |
| Containers | disk is ephemeral, no volumes | — | — | yes |
| **Durable Object** | **yes, per object** | **yes** | **yes** | **yes** |

Durable Objects expose SQLite through `ctx.storage.sql.exec()`, which returns a
cursor rather than a promise, and `ctx.storage.transactionSync()`, which is
documented as being for exactly this. That is what turns a rewrite into a port.

## What was actually verified

Against real workerd (wrangler 4.129.1, `--local`), not from documentation:

```
10/10  src/sqlite-probe.js
  exec() returns a cursor, not a Promise
  a row reads synchronously with no await
  iteration is synchronous too
  FTS5 with the porter unicode61 tokenizer works
  bm25() and snippet() are available
  json_each filters work
  transactionSync propagates the error
  a failed transactionSync rolled the write back
  a committing transactionSync keeps its writes
  foreign key enforcement is on by default

6/6   src/express-in-do.js
  a POST with a JSON body works
  a GET through an Express Router reads synchronous SQL
  Express sets its own JSON content type
  the 404 fall-through middleware runs
  the error-handling middleware catches a throwing route
```

Run them yourself:

```bash
cd salesos/cloudflare/spike && npm install
npm run sqlite    # then: curl localhost:8787/
npm run express   # then: curl localhost:8787/__probe
```

The schema clears every Durable Object SQLite limit with room to spare:

| Limit | Ceiling | This schema |
| --- | --- | --- |
| Columns per table | 100 | 36 (`calls`) |
| Bound parameters per query | 100 | 36 (widest `insert`) |
| Row / string / BLOB size | 2 MB | 5.7 KB (0.27%) |
| Database size | 10 GB | 1.9 MB seeded |

## The two things that bite

**Express 4 does not bundle for workerd as-is.** `express.json` and
`express.urlencoded` are lazy getters, and esbuild's CJS interop enumerates the
module's properties, which fires them at import time — so `body-parser` loads
even if it is never called, and it reaches `iconv-lite`, whose stream support
throws `require_streams(...) is not a function` during module evaluation. The
worker fails to start, with no route ever running.

Aliasing `iconv-lite` to a stub fixes it (see `wrangler.express.toml`), and is
safe here because nothing decodes a non-UTF-8 body: the bridge in
`express-in-do.js` reads the body itself and sets `req.body`. `express.json()`
must come out of `app.js` for the same reason.

**A Durable Object has no socket, so Express needs a bridge.** `cloudflare:node`
does export `httpServerHandler`, but it is written for a Worker's default
export. `serve()` in `express-in-do.js` is the alternative: it turns a Fetch
`Request` into the small subset of `IncomingMessage`/`ServerResponse` that
Express actually touches, and resolves a `Response` from `res.end()`. About 60
lines, and the app above it cannot tell the difference.

## What still has to change, and what does not

Unchanged: `db/index.js`'s 13 helpers keep their signatures, all 478 call sites,
the `transaction()` helper, all 99 sync service functions, the 21 routers, the
151 route handlers, `scrypt` auth (natively implemented, ~37 ms CPU measured on
workerd against ~42 ms on Node here), and the RBAC layer.

Still to do:

- **The db driver.** `getDb()` returns a `DatabaseSync`; it needs a sibling that
  wraps `ctx.storage.sql`. `all`/`get`/`run` map onto `exec(...)` directly.
  `PRAGMA journal_mode = WAL` and `busy_timeout` go away — a Durable Object is
  single-threaded, which is what those settings were approximating.
- **The scheduler.** Four `setInterval` loops become Cron Triggers (one-minute
  granularity, which is exactly what they use) or DO Alarms. Note `setInterval`
  inside a Durable Object blocks hibernation.
- **The job queue.** It can stay as-is, driven by an alarm instead of a timer,
  because the object is long-lived and single-threaded — the atomic-claim
  `UPDATE` is still correct. Cloudflare Queues is the alternative and is
  at-least-once, so it would need an idempotency key the current queue does not
  have.
- **Recordings.** Already done: `STORAGE_DRIVER=r2` uses the SigV4 driver in
  `server/src/services/storage/provider.s3.js`.
- **SSE.** It works and has no documented duration limit, but an open stream is
  an in-flight request, so it blocks hibernation and bills wall-clock for the
  whole connection. Cloudflare documents the same workload at $142.95/mo on
  standard WebSockets against $20.65/mo with hibernation, so converting the
  stream to a WebSocket is a real saving — and a client change too.
- **Cross-organisation sweeps.** `services/automation/index.js` iterates every
  organisation twice. With one object for the whole app that is unchanged; with
  an object per organisation it becomes the cron fan-out.

## Sourcing

`developers.cloudflare.com` is blocked by this environment's egress policy, so
the documentation was read from `cloudflare/cloudflare-docs` — the repository
that renders that site — at commit `26ef2e07`, dated 2026-09-07. Every runtime
claim above was then checked against workerd locally rather than trusted.
