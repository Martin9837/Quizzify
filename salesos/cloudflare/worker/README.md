# The API as a Durable Object

This is the deployable shape, and it is the whole product: the dashboard and
the API from one Worker, at one origin, in one deploy. `src/index.js` is a
Durable Object holding the application — the Express app from
`server/src/app.js` unmodified, its SQLite in the object's own storage, the job
queue driven by an alarm and the scheduler by a cron trigger — and the built
client is served alongside it as static assets.

Same origin is the point. There is no CORS to configure, no `WEB_ORIGINS` to
keep in step, and no API base URL baked into the bundle at build time, so the
client does not have to be rebuilt to point somewhere else. Requests are routed
by `run_worker_first`: `/api/*` and `/health` reach the Worker, everything else
is matched against the assets, and anything left over falls back to
`index.html` so a deep link like `/admin/users` renders instead of 404ing.

One object for everything is deliberate — it is the shape the server already
has. One database, one job runner, one rate limiter, one connection registry,
all of which assume a single process, and a Durable Object is single-threaded,
so they stay correct. Sharding by organisation later is a routing change
(`getByName(orgId)`), which the schema already permits since every business
table carries an `organization_id`; it is not the first step, because it turns
the two cross-organisation sweeps in `services/automation` into a fan-out.

## Trying it locally

```bash
cd salesos/cloudflare/worker
npm install
cp .dev.vars.example .dev.vars          # local keys, never deployed
npm run build --prefix ../../web        # the dashboard the Worker serves
npm run dev                             # http://localhost:8787
npm run smoke                           # 32 checks over the real API
npm run dashboard                       # 23 checks driving the real UI
npm run coldstart                       # 12 concurrent requests at an empty object
```

There is no seed step. The demo organisation loads by itself on the first
request that reaches the object — see `ensureBootstrapped()`.

`npm run dashboard` signs in through the browser and walks all sixteen routes
the SPA declares, requiring each to render something that is not the client's
own "Page not found" screen — an earlier version of that check passed a 404
page because it only asserted the text was long enough. It also verifies the
deep-link fallback survives a full page load, that every API request goes to
the page's own origin, and that an agent's dashboard shows real figures. Set
`CHROMIUM_PATH` if a browser is already on the machine.

All three harnesses take `BASE` (and `parity.mjs` also takes `NODE_BASE`), so
they can be pointed at whichever port is free, or at a real deployment.

Note the home dashboard is *personal* — "Calls today", "Who to call today",
your quota — so an admin who owns no leads correctly sees zeros while still
seeing every lead in the list views. The check signs in as an agent for that
reason.

`parity.mjs` runs the same request sequence against a Node instance and the
Durable Object and compares them. With a Node server on :4300 and the object on
:8787, all 19 requests answer identically — including the ones that should
fail, which is the half that catches a bridge quietly swallowing an error.

## Deploying

```bash
npx wrangler login      # once
npm run deploy
```

That is the whole thing. It prints the URL —
`https://salesos.<your-subdomain>.workers.dev` — and the password to sign in
with.

`deploy.mjs` exists because three things have to happen together and the
obvious order does not work:

- **The client is built first.** Assets are uploaded from `web/dist`, so
  deploying without building ships whatever was there last, or nothing.
- **The secrets go up with the first version**, via `--secrets-file`. In
  production the server refuses to boot without `JWT_SECRET` and
  `ENCRYPTION_KEY`, and `wrangler secret put` cannot target a Worker that does
  not exist yet — so setting them afterwards means the first version is dead on
  arrival.
- **`DEMO_PASSWORD` is generated.** The bootstrap refuses to create accounts
  without it, because the seeder's default password is published in this
  repository and the deployment is a public URL.

Secrets are kept in `.secrets.json` (gitignored, mode 600) and reused on later
deploys, because replacing `JWT_SECRET` signs everyone out and replacing
`ENCRYPTION_KEY` makes stored recordings unreadable.

Recordings need a bucket, which is the one thing not automatic:

```bash
npx wrangler r2 bucket create salesos-recordings
```

Then point the storage driver at it with `S3_*` secrets — the driver speaks the
S3 API, which is why it also works from Node. Until that is done, everything
works except storing a recording; seeding and the whole dashboard do not touch
object storage, which is verified.

`WEB_ORIGINS` is not needed — the client is served from this same Worker, so
nothing is cross-origin. Set `PUBLIC_URL` to the deployed URL, which the API
uses when it builds links into emails.

## The first request to a new deployment

A deployed Worker starts with an empty database and no way to create the first
account: the seeder is a CLI entry point and there is no shell. So the URL would
serve a login page nobody could get past.

`ensureBootstrapped()` loads the demo organisation, under three conditions that
all have to hold:

1. `SALESOS_BOOTSTRAP=demo` is set — never by accident.
2. The database has no organisations. This is the load-bearing one: after the
   first run it can never fire again, whatever the configuration says, so it
   cannot touch real data.
3. `DEMO_PASSWORD` is set. Without it the bootstrap logs an error and does
   nothing rather than creating accounts on a password published in this repo.

It runs inside `ctx.blockConcurrencyWhile()` in the constructor, which is the
documented way to initialise a Durable Object: the runtime defers every incoming
request until it finishes, so nothing observes a half-seeded database. A promise
awaited from `fetch()` is not equivalent — input gates protect storage calls,
but awaiting other async work opens the gate and lets the next request
interleave. Nothing inside may throw, either: a rejected callback aborts the
object, so a failed seed would take the application down instead of leaving it
merely empty. Both failure paths are caught and logged.

`npm run coldstart` fires twelve concurrent logins at an empty object and
asserts they all see one consistently seeded database.

Recordings go to R2 through `S3_*` credentials rather than the binding, because
the storage driver speaks the S3 API and therefore also works from Node — see
`docs/DEPLOY.md`. Both plans are fine on size (64 MiB uncompressed; the bundle
is about 1.1 MB), but Durable Objects with SQLite storage want Workers Paid.

## What is not solved here

- **SSE keeps the object awake.** The bridge streams `text/event-stream`
  correctly, but an open stream is an in-flight request, so the object cannot
  hibernate and bills wall-clock for the connection's whole life. Cloudflare
  documents the same workload at $142.95/mo on standard WebSockets against
  $20.65/mo with hibernation, so converting the stream to a WebSocket is worth
  real money — and is a client change too.
- **The cron trigger only drains the queue.** The four `setInterval` loops in
  `server/src/index.js` are not wired to it yet; `scheduled()` calls the object,
  which drains jobs. The automation sweeps still need connecting.
- **`express.json()` never runs.** The bridge parses the body and sets
  `req._body`, which is body-parser's own short-circuit, and enforces the same
  12 MB limit itself. The middleware stays in `app.js` so the Node path is
  unchanged, but `iconv-lite` still has to be aliased away because esbuild's CJS
  interop loads it regardless — see `../README.md`.
