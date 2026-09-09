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
npx wrangler dev -c wrangler.dev.toml --local --port 8787
curl -X POST localhost:8787/__seed      # the demo organisation
npm run smoke                           # 32 checks over the real API
npm run dashboard                       # 23 checks driving the real UI
```

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

`__seed` needs two conditions, both of which the production config withholds:
`SALESOS_ALLOW_DEMO_SEED=true` and an environment that is not production. The
demo accounts share a published password, so it must not be reachable on
anything real.

`parity.mjs` runs the same request sequence against a Node instance and the
Durable Object and compares them. With a Node server on :4300 and the object on
:8787, all 19 requests answer identically — including the ones that should
fail, which is the half that catches a bridge quietly swallowing an error.

## Deploying

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put ENCRYPTION_KEY
npx wrangler r2 bucket create salesos-recordings
npm run deploy      # builds the client, then deploys both
```

`npm run deploy` builds `web/dist` first on purpose: the assets are uploaded
from that directory, so deploying without building ships whatever was there
last — or nothing at all.

Then add the R2 bucket for recordings:

```toml
[[r2_buckets]]
binding = "RECORDINGS"
bucket_name = "salesos-recordings"
```

`WEB_ORIGINS` is not needed — the client is served from this same Worker, so
nothing is cross-origin. Set `PUBLIC_URL` to the deployed URL, which the API
uses when it builds links into emails.

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
