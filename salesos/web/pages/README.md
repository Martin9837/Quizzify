# Cloudflare Pages configuration

`_redirects` lives here rather than in `public/` because it applies to exactly
one of the two ways this client is served.

- **Served by the Worker** (`cloudflare/worker/`, the recommended path): the SPA
  fallback is configured with `not_found_handling = "single-page-application"`.
  The `/*  /index.html  200` rule below is not just redundant there, it is a
  redirect loop — index.html is itself an asset — so wrangler parses it, warns
  and ignores it on every deploy. A standing warning is how a real one gets
  missed, so the file is kept out of the default build.
- **Served by Pages**: the rule is required, and `npm run build:pages` copies it
  into `dist/`.

`_headers` stays in `public/` because both paths honour it, and both need it:
the service worker must not be served from a stale cache, and the
content-hashed assets should be immutable.
