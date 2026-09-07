# The API as a Durable Object

This is the deployable shape. `src/index.js` is one Durable Object holding the
whole application: the Express app from `server/src/app.js` unmodified, its
SQLite in the object's own storage, the job queue driven by an alarm and the
scheduler by a cron trigger.

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
npx wrangler dev -c wrangler.dev.toml --local --port 8787
curl -X POST localhost:8787/__seed      # the demo organisation
node smoke.mjs                          # 32 checks over the real API
```

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
npx wrangler deploy
```

Then add the R2 binding and the client's origin, or CORS refuses every request:

```toml
[[r2_buckets]]
binding = "RECORDINGS"
bucket_name = "salesos-recordings"

[vars]
WEB_ORIGINS = "https://salesos.pages.dev"
PUBLIC_URL = "https://salesos-api.<subdomain>.workers.dev"
```

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
