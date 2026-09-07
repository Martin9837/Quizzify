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

## The API is not a Workers app

Cloudflare Workers cannot run this server, and the gap is not a configuration
detail:

| What the server does | Workers equivalent | Cost to move |
| --- | --- | --- |
| 570 synchronous `node:sqlite` calls across 36 files | D1, which is async | Every call becomes `await`, and async cascades through the services and routes above them |
| Express, 21 routers | Hono or itty-router | Rewrite the HTTP layer |
| Job queue with in-process workers | Cloudflare Queues | Rewrite the queue; Workers are request-scoped |
| 4 `setInterval` scheduler loops | Cron Triggers | Rewrite scheduling |
| SSE with an in-memory per-org connection registry | Durable Objects | Rewrite realtime; isolates share no memory |
| Local encrypted recording storage, 5 `fs` call sites | R2 | Rewrite the storage provider |
| `scrypt` password hashing, 8 call sites | Web Crypto / `nodejs_compat` | Verify availability and CPU limits |

That is a port, not a deployment. The provider abstractions make each piece
replaceable in isolation, so it is achievable — but it is a project, and nothing
about it is a prerequisite for getting the product live.

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

To stay on Cloudflare, **Cloudflare Containers** runs a container image and
keeps the Node process intact. Otherwise Fly.io, Render and Railway all take
this shape directly.

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
