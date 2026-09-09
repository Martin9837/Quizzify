/**
 * Deploy SalesOS to Cloudflare in one command.
 *
 * Three things have to happen together, and getting the order wrong leaves a
 * Worker that is deployed and dead:
 *
 *   1. The client is built. The assets are uploaded from `web/dist`, so
 *      deploying without building ships whatever was there last, or nothing.
 *   2. The secrets go up WITH the first version. In production the server
 *      refuses to boot without JWT_SECRET and ENCRYPTION_KEY -- deliberately,
 *      because a silent weak key is worse than a crash -- and
 *      `wrangler secret put` cannot target a Worker that does not exist yet.
 *      `--secrets-file` uploads them as part of the deploy, so the very first
 *      version boots.
 *   3. DEMO_PASSWORD is generated. The bootstrap refuses to create accounts
 *      without it, because the seeder's default password is published in this
 *      repository and the deployment is a public URL.
 *
 * Existing secrets are reused, so redeploying does not invalidate every
 * session (JWT_SECRET) or orphan every stored recording (ENCRYPTION_KEY).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const secretsPath = resolve(here, '.secrets.json');
const repoRoot = resolve(here, '../..');

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', ...options });

// ---------------------------------------------------------------- secrets ---
let secrets = {};
if (existsSync(secretsPath)) {
  secrets = JSON.parse(readFileSync(secretsPath, 'utf8'));
  console.log(`Reusing the secrets in ${secretsPath}`);
} else {
  console.log('Generating secrets (kept locally, never committed)');
}

const hex = (bytes) => randomBytes(bytes).toString('hex');
/** Readable, unambiguous, and long enough to be pointless to guess. */
const password = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(20);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
};

secrets.JWT_SECRET ??= hex(32);
secrets.ENCRYPTION_KEY ??= hex(32);
secrets.DEMO_PASSWORD ??= password();

mkdirSync(dirname(secretsPath), { recursive: true });
writeFileSync(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });

// ------------------------------------------------------------------ build ---
console.log('\nBuilding the dashboard');
run('npm', ['run', 'build', '--prefix', resolve(repoRoot, 'web')]);

// ----------------------------------------------------------------- deploy ---
console.log('\nDeploying');
const extra = process.argv.slice(2);
run('npx', ['wrangler', 'deploy', '--secrets-file', secretsPath, ...extra], { cwd: here });

console.log(`
Deployed. Sign in with:

  email     admin@northstar.demo
  password  ${secrets.DEMO_PASSWORD}

The demo organisation loads on the first request, and only into an empty
database -- it can never overwrite real data, whatever the configuration says.

Other accounts from the same seed, on the same password:
  manager@northstar.demo   a sales manager, sees one team
  agent@northstar.demo     a sales agent, sees only their own records
  owner@northstar.demo     super admin

Change that password from Admin -> Users before sharing the URL widely. The
secrets are in ${secretsPath} (gitignored, mode 600); keep them, because
replacing JWT_SECRET signs every session out and replacing ENCRYPTION_KEY makes
stored recordings unreadable.
`);
