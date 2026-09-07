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

And then the one that matters, which imports `server/src/db/index.js` and the
real `schema.sql` rather than re-implementing either:

```
19/19  src/real-db.js
  the real 634-line schema applies                     (37 tables, FTS5 shadow tables included)
  the FTS5 virtual table is among them
  insert() then get() round-trips
  a plain object comes back, not a null-prototype row
  a Date parameter is coerced to an ISO string
  a boolean parameter is coerced to 1
  a successful guarded UPDATE reports changes = 1
  a losing guarded UPDATE reports changes = 0           <- no double claim
  changes counts every row a multi-row UPDATE touched
  changes is 0 when nothing matched
  transaction() propagates the error
  a failed transaction() rolled the write back
  a committing transaction() keeps its writes
  a dangling foreign key becomes a 400, not a 500
  the real FTS5 query shape works                       (snippet + bm25 + MATCH)
  json_each filters work, with the array coerced by normalise()
  hydrate() parses the JSON column back out
  ON DELETE CASCADE removed the dependent rows
  the probe can re-run against persisted storage
```

The four `changes` checks are the load-bearing ones. `cursor.rowsWritten`
counts index rows as well, so it is *not* `changes()` — and the job queue's
atomic claim (`UPDATE ... WHERE status = 'pending'`) turns on that number being
exact, since a wrong one would let two workers run the same job. The driver
reads `SELECT changes()` after the write instead, which is safe because a
Durable Object is single-threaded.

Run them yourself:

```bash
cd salesos/cloudflare/spike && npm install
npm run sqlite    # then: curl localhost:8787/
npm run express   # then: curl localhost:8787/__probe
npm run realdb    # then: curl localhost:8787/
```

The schema clears every Durable Object SQLite limit with room to spare:

| Limit | Ceiling | This schema |
| --- | --- | --- |
| Columns per table | 100 | 36 (`calls`) |
| Bound parameters per query | 100 | 36 (widest `insert`) |
| Row / string / BLOB size | 2 MB | 5.7 KB (0.27%) |
| Database size | 10 GB | 1.9 MB seeded |

## Four things that only showed up by running it

None of these are visible from the documentation, and each one stopped the
worker from starting at all — before any route ran:

1. **`import.meta.url` is undefined on Workers.** `db/index.js`, `config.js`
   and `app.js` each computed `__dirname` from it at module scope, so module
   evaluation threw. All three now resolve it lazily, at the point the path is
   actually needed — which is only ever to read a file from a disk.
2. **Generating random values in global scope is forbidden.** `config.js` minted
   a throwaway JWT/encryption key at import when the environment did not supply
   one: "Disallowed operation called within global scope". It is generated on
   first read and memoised now. The eager *presence* check that makes a
   production process refuse to start without real keys is unchanged and still
   tested; only the random fallback moved.
3. **`node:fs` is a memory-backed virtual FS**, so `schema.sql` cannot be read
   from disk. `migrate()` takes the SQL as an argument now, and the Durable
   Object bundles the file as text and hands it over.
4. **`PRAGMA journal_mode = WAL` is rejected** with `SQLITE_AUTH`. The driver
   skips `journal_mode`, `busy_timeout` and `foreign_keys`: a Durable Object is
   single-threaded and always enforces foreign keys, which is a stronger
   guarantee than what those settings were arranging. The driver also names the
   offending statement on failure, because "not authorized" against a
   77-statement script otherwise says nothing at all.

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

- ~~**The db driver.**~~ **Done.** `server/src/db/index.js` keeps all 13 of its
  exports and delegates five primitives to a driver: `driver.node.js` is the
  existing `node:sqlite` engine, `driver.do.js` the Durable Object one. No call
  site changed, and all 150 server tests pass on the node driver. A test asserts
  nothing under `db/` reaches for `node:sqlite` behind the driver's back, since
  that would work on Node and fail only once deployed.
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
