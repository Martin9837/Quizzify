/**
 * Decide which application secrets this deploy has to carry.
 *
 * Secrets already stored on Cloudflare are left alone: regenerating JWT_SECRET
 * would sign every session out, and regenerating ENCRYPTION_KEY would make
 * stored recordings unreadable. So only the missing ones are written, and they
 * travel with the deploy via --secrets-file rather than through
 * `wrangler secret put`, which cannot target a Worker that does not exist yet.
 *
 * Reads existing.json (the output of `wrangler secret list`, or `[]` on a first
 * run) and writes secrets.json plus the step outputs.
 */
const { randomBytes } = require('node:crypto');
const { readFileSync, writeFileSync, appendFileSync } = require('node:fs');

let existing = [];
try {
  const parsed = JSON.parse(readFileSync('existing.json', 'utf8'));
  if (Array.isArray(parsed)) existing = parsed.map((entry) => entry?.name).filter(Boolean);
} catch {
  // A first run, or output that is not JSON: treat everything as missing. The
  // deploy is additive, so writing a secret that already exists is harmless --
  // whereas skipping one that does not exist stops the Worker from booting.
}

/** Readable, unambiguous, and long enough to be pointless to guess. */
const password = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(randomBytes(20), (byte) => alphabet[byte % alphabet.length]).join('');
};

const out = {};
let generatedPassword = '';

for (const name of ['JWT_SECRET', 'ENCRYPTION_KEY', 'DEMO_PASSWORD']) {
  if (existing.includes(name)) {
    console.log(`${name}: already on Cloudflare, left alone`);
    continue;
  }
  const supplied = process.env[name];
  if (supplied) {
    out[name] = supplied;
    console.log(`${name}: taken from a repository secret`);
    continue;
  }
  if (name === 'DEMO_PASSWORD') {
    generatedPassword = password();
    out[name] = generatedPassword;
  } else {
    out[name] = randomBytes(32).toString('hex');
  }
  console.log(`${name}: generated`);
}

writeFileSync('secrets.json', `${JSON.stringify(out)}\n`, { mode: 0o600 });

const output = process.env.GITHUB_OUTPUT;
if (output) {
  appendFileSync(output, `write_secrets=${Object.keys(out).length ? 'yes' : 'no'}\n`);
  if (generatedPassword) appendFileSync(output, `generated_password=${generatedPassword}\n`);
}
