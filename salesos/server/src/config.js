import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// `import.meta.url` is undefined on Workers, where computing this eagerly threw
// before any code could run. Nothing that matters on a host without a
// filesystem depends on the path -- the .env loader and the default storage
// root -- so it degrades to a placeholder instead of taking the process down.
const moduleDir = import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : '';
const serverRoot = moduleDir ? path.resolve(moduleDir, '..') : '/';

// Minimal .env loader (avoids a dependency; ignores comments and blank lines).
function loadDotEnv() {
  for (const file of ['.env', '../.env']) {
    const full = path.resolve(serverRoot, file);
    if (!fs.existsSync(full)) continue;
    for (const raw of fs.readFileSync(full, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
loadDotEnv();

const env = process.env;
const bool = (v, d = false) => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

// In development we generate ephemeral secrets so the app boots with zero setup.
// In production a missing secret is fatal: silent weak keys are worse than a crash.
const nodeEnv = env.NODE_ENV || 'development';
// A production process must refuse to start without these rather than fall back
// to an ephemeral key, so the presence check stays eager. It generates nothing,
// which is what lets it run at import time on every host.
const REQUIRED_SECRETS = ['JWT_SECRET', 'ENCRYPTION_KEY'];
if (nodeEnv === 'production') {
  for (const name of REQUIRED_SECRETS) {
    if (!env[name]) throw new Error(`${name} must be set in production`);
  }
}

const generatedSecrets = new Map();

/**
 * The configured secret, or a throwaway one outside production.
 *
 * The throwaway is generated on first read rather than at import: Workers
 * forbids generating random values in global scope ("Disallowed operation
 * called within global scope"), and this ran during module evaluation even when
 * the value was never used. Memoised, so a key stays stable for the life of the
 * process -- a changing one would invalidate every session it had just signed.
 */
function secret(name, fallbackBytes = 32) {
  if (env[name]) return env[name];
  if (nodeEnv === 'production') {
    throw new Error(`${name} must be set in production`);
  }
  if (!generatedSecrets.has(name)) {
    generatedSecrets.set(name, randomBytes(fallbackBytes).toString('hex'));
  }
  return generatedSecrets.get(name);
}

export const config = {
  env: nodeEnv,
  isProd: nodeEnv === 'production',
  port: int(env.PORT, 4000),
  host: env.HOST || '0.0.0.0',
  publicUrl: env.PUBLIC_URL || `http://localhost:${int(env.PORT, 4000)}`,
  webOrigins: (env.WEB_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((s) => s.trim()),

  db: {
    file: env.DATABASE_FILE || path.resolve(serverRoot, 'data/salesos.db'),
  },

  auth: {
    get jwtSecret() { return secret('JWT_SECRET'); },
    accessTtlSeconds: int(env.ACCESS_TOKEN_TTL, 60 * 60 * 12),
    refreshTtlSeconds: int(env.REFRESH_TOKEN_TTL, 60 * 60 * 24 * 30),
    // scrypt parameters -- cost tuned for interactive logins
    scrypt: { N: 16384, r: 8, p: 1, keylen: 64 },
  },

  // Used to encrypt integration credentials and (optionally) recordings at rest.
  encryption: {
    get key() { return secret('ENCRYPTION_KEY'); },
  },

  storage: {
    driver: env.STORAGE_DRIVER || 'local', // local|s3|r2
    root: env.STORAGE_ROOT || path.resolve(serverRoot, 'data/objects'),
    encryptAtRest: bool(env.STORAGE_ENCRYPT_AT_REST, true),
    s3: {
      bucket: env.S3_BUCKET,
      // R2 has no regions; the signer substitutes "auto" when an endpoint is set.
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  },

  ai: {
    // 'auto' uses Anthropic when a key is present and falls back to the built-in
    // deterministic engine otherwise, so the product is fully usable offline.
    provider: env.AI_PROVIDER || 'auto', // auto|anthropic|local
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY || '',
      baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      maxTokens: int(env.ANTHROPIC_MAX_TOKENS, 4096),
      timeoutMs: int(env.AI_TIMEOUT_MS, 60000),
    },
    // Speech-to-text, when an external provider is configured. `config.ai.sttUrl`
    // was read but never defined, so this always fell through to the raw
    // environment; it is a real setting now, with a deadline of its own.
    stt: {
      url: env.STT_URL || '',
      apiKey: env.STT_API_KEY || '',
      // 180s was the hardcoded deadline before this became configurable; the
      // default keeps it, so making it settable changed nothing on its own.
      timeoutMs: int(env.STT_TIMEOUT_MS, 180000),
    },
  },

  telephony: {
    provider: env.TELEPHONY_PROVIDER || 'simulator', // simulator|twilio
    callerId: env.TELEPHONY_CALLER_ID || '+15550100',
    maskingEnabled: bool(env.TELEPHONY_MASKING, true),
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || '',
      authToken: env.TWILIO_AUTH_TOKEN || '',
      appSid: env.TWILIO_TWIML_APP_SID || '',
    },
  },

  email: {
    provider: env.EMAIL_PROVIDER || 'log', // log|smtp|google|microsoft
    fromName: env.EMAIL_FROM_NAME || 'SalesOS',
    fromAddress: env.EMAIL_FROM_ADDRESS || 'no-reply@salesos.local',
    smtp: {
      host: env.SMTP_HOST,
      port: int(env.SMTP_PORT, 587),
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  },

  queue: {
    concurrency: int(env.QUEUE_CONCURRENCY, 3),
    pollIntervalMs: int(env.QUEUE_POLL_MS, 750),
    enabled: bool(env.QUEUE_ENABLED, true),
    // A handler that never returns would otherwise hold its slot for the life
    // of the process. Generous enough for a slow transcription and analysis
    // chain; short enough that a hang is recovered the same day.
    jobTimeoutMs: int(env.QUEUE_JOB_TIMEOUT_MS, 300000),
    // How long a job may sit 'running' before another worker may take it over.
    abandonAfterSeconds: int(env.QUEUE_ABANDON_AFTER_SECONDS, 600),
  },

  scheduler: {
    enabled: bool(env.SCHEDULER_ENABLED, true),
    intervalMs: int(env.SCHEDULER_INTERVAL_MS, 60000),
  },

  rateLimit: {
    windowMs: int(env.RATE_LIMIT_WINDOW_MS, 60000),
    max: int(env.RATE_LIMIT_MAX, 600),
    authMax: int(env.RATE_LIMIT_AUTH_MAX, 20),
  },

  logging: {
    level: env.LOG_LEVEL || (nodeEnv === 'production' ? 'info' : 'debug'),
    pretty: bool(env.LOG_PRETTY, nodeEnv !== 'production'),
  },

  seed: {
    demoPassword: env.DEMO_PASSWORD || 'Demo1234!',
  },
};

export default config;
