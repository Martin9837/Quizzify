import config from '../config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logging.level] ?? LEVELS.info;

const COLORS = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';

// Redact obvious secrets so structured logs are safe to ship anywhere.
const SECRET_KEYS = /^(password|password_hash|token|refresh_token|access_token|secret|api_key|authorization|credentials_enc)$/i;
function scrub(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : scrub(v, depth + 1);
  return out;
}

function emit(level, message, meta) {
  if ((LEVELS[level] ?? 2) > threshold) return;
  const record = { ts: new Date().toISOString(), level, message, ...scrub(meta || {}) };
  if (config.logging.pretty) {
    const { ts, ...rest } = record;
    delete rest.level;
    delete rest.message;
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    process.stdout.write(`${COLORS[level] || ''}${level.padEnd(5)}${RESET} ${ts.slice(11, 23)} ${message}${extra}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

const bind = (base) => ({
  error: (m, meta) => emit('error', m, { ...base, ...meta }),
  warn: (m, meta) => emit('warn', m, { ...base, ...meta }),
  info: (m, meta) => emit('info', m, { ...base, ...meta }),
  debug: (m, meta) => emit('debug', m, { ...base, ...meta }),
  child: (more) => bind({ ...base, ...more }),
});

export const logger = bind({});
export default logger;
