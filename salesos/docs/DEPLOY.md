# Deploying SalesOS

The client is static files and deploys to any CDN, Cloudflare Pages included.
The API is a long-lived Node process with a local SQLite database, a background
job queue and an SSE stream, and it needs somewhere that can run that.

Those two facts decide everything below.

## The client on Cloudflare Pages

The build is about 700 KB of static assets, so Pages serves it as-is.

```bash
cd salesos
VITE_API_BASE=https://api.your-domain.com npm run build
npx wrangler pages deploy web/dist --project-name salesos
```

`VITE_API_BASE` is baked in at build time and matters: served from Pages the
client and the API are on different origins, and with no base set the client
uses relative URLs and asks Pages for `/api/v1/...`, which does not exist there.
Rebuild to change it.

Two files in `web/public/` configure Pages and ship with the build:

- `_redirects` sends unmatched paths to `index.html`, so a deep link like
  `/admin/users` renders instead of 404ing. Static assets are matched first.
- `_headers` marks `/sw.js` `no-cache` and the content-hashed `/assets/*`
  immutable. The service worker decides when everything else refreshes, so it
  must not itself be served stale — a cached worker delays a deploy.

Then allow the Pages origin on the API, or every request is refused by CORS:

```bash
WEB_ORIGINS=https://salesos.pages.dev,https://app.your-domain.com
```

This topology is tested: `scratchpad/cdn.mjs` serves the built client on one
origin against the API on another, with no proxy, and checks deep links, a
cross-origin sign-in, the admin dashboard rendering real data, and that every
request goes to the API origin.

## The API on Cloudflare: a Durable Object, not a Worker

The API keeps its database in a local SQLite file and reaches it through 478
synchronous calls across 36 files. Anything that makes those asynchronous
cascades: 99 exported service functions change signature, and the 21 routers
above them follow. That single fact decides which Cloudflare product can host
this server.

| | Local SQLite | Synchronous SQL | FTS5 | Long-lived process |
| --- | --- | --- | --- | --- |
| Workers alone | `node:sqlite` is a non-functional stub | -- | -- | no |
| Workers + D1 | no | **no**, every method is awaited | yes | no |
| Containers | disk is ephemeral, no volumes | -- | -- | yes |
| **Durable Object** | **yes, per object** | **yes** | **yes** | **yes** |

A Durable Object exposes SQLite through `ctx.storage.sql.exec()`, which returns
a cursor rather than a promise, and `ctx.storage.transactionSync()`. That turns
what would be a rewrite into a port: the db helpers keep their signatures, all
478 call sites stay as written, and the object being single-threaded is what
the in-memory rate limiter and the SSE connection registry already assume.

This is verified against real workerd, not inferred -- 10 checks on the storage
engine and 6 on Express serving from inside the object. See
`../cloudflare/README.md` for what was tested, the two incompatibilities that
have to be worked around (`express.json()` reaches `iconv-lite`, which does not
load; and a Durable Object has no socket, so Express needs a small bridge), and
the list of what still has to change. The spike is runnable.

D1 remains a reasonable choice if you would rather pay the async migration than
adopt Durable Objects -- it supports FTS5 and JSON1 -- but note its 100
bound-parameter cap, that it has no interactive transactions (`BEGIN` is
rejected, so the `transaction()` helper cannot port as a callback), and that
having an FTS5 table disables `wrangler d1 export` for the whole database.

## Running the API

Anywhere that runs a Node 22.5+ process with a persistent disk:

```bash
NODE_ENV=production \
JWT_SECRET=$(openssl rand -hex 32) \
ENCRYPTION_KEY=$(openssl rand -hex 32) \
WEB_ORIGINS=https://salesos.pages.dev \
PUBLIC_URL=https://api.your-domain.com \
DATABASE_FILE=/data/salesos.db \
npm start
```

`JWT_SECRET` and `ENCRYPTION_KEY` are mandatory in production — the server
refuses to boot without them rather than falling back to the ephemeral
development keys, because a silent weak key is worse than a crash. Both must be
stable across restarts: change `JWT_SECRET` and every session is invalidated,
change `ENCRYPTION_KEY` and stored recordings cannot be decrypted.

`DATABASE_FILE` must point at a persistent volume. On a platform with an
ephemeral filesystem the database is lost on every deploy.

## Where recordings go

By default call recordings are written to local disk under `STORAGE_ROOT`,
AES-256-GCM encrypted. Anywhere without a persistent disk, point them at an
S3-compatible bucket instead -- R2 included:

```bash
STORAGE_DRIVER=r2 \
S3_BUCKET=salesos-recordings \
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
S3_ACCESS_KEY_ID=... \
S3_SECRET_ACCESS_KEY=...
```

`r2` and `s3` are the same SigV4 driver; the alias just says what you meant.
For AWS, give `S3_REGION` and leave `S3_ENDPOINT` unset. The blob is sealed
before it is uploaded, so the bucket never holds a recording it could read --
which also means `ENCRYPTION_KEY` must survive, or the recordings are
unreadable no matter who holds the bucket.

Fly.io, Render and Railway all take this shape directly.

**Cloudflare Containers does not**, despite running a container image: "all
disk is ephemeral -- when a Container instance goes to sleep, the next time it
is started, it will have a fresh disk", and there are no volumes. The Express
app, the job workers and the scheduler loops would all run unchanged there --
Containers has no maximum instance lifetime -- but the database would be lost
on every sleep, so the data layer has to move regardless. To stay on
Cloudflare, use a Durable Object, per the section above.

## Before it faces real users

- Serve the API over HTTPS. iOS App Transport Security requires it for anything
  off the local network, and so do the browser's cookie rules.
- Set `ANTHROPIC_API_KEY` for model-backed analysis, or leave it unset and the
  built-in deterministic engine handles transcription, analysis, extraction and
  drafting through the same interfaces.
- Reset the demo data. `npm run seed` creates the Northstar organisation with
  four accounts on a published password; none of that belongs in production.
- Take the retention and consent settings seriously — see `SECURITY.md`. Call
  recording consent is a legal matter and the default is the safest one.
- The rate limiter and job queue are in-process, so more than one API instance
  means each keeps its own. See `ARCHITECTURE.md` for the scaling path.
