import { insert, all, get, run } from '../../db/index.js';
import { id } from '../../lib/ids.js';
import { nowIso, addSeconds } from '../../lib/time.js';
import config from '../../config.js';
import logger from '../../lib/logger.js';

/**
 * Durable job queue backed by the primary database.
 *
 * Transcription and AI analysis must not run inside a request: they are slow
 * and failure-prone. Persisting jobs means a restart mid-analysis resumes
 * rather than silently losing the work, and `attempts`/`run_after` give
 * exponential backoff without an external broker. The same table would be
 * served by Redis/SQS in a multi-node deployment -- only `claim()` changes.
 */

const handlers = new Map();
const workerId = `w_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
let running = 0;
let timer = null;
let stopped = false;

export function registerHandler(type, handler) {
  handlers.set(type, handler);
}

export function registeredTypes() {
  return [...handlers.keys()];
}

export function enqueue(type, payload = {}, { organizationId = null, delaySeconds = 0, priority = 5, maxAttempts = 3 } = {}) {
  const job = {
    id: id('job'),
    organization_id: organizationId,
    type,
    payload: JSON.stringify(payload),
    status: 'pending',
    priority,
    attempts: 0,
    max_attempts: maxAttempts,
    run_after: delaySeconds > 0 ? addSeconds(delaySeconds) : nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('jobs', job);
  logger.debug('job enqueued', { type, jobId: job.id, delaySeconds });
  return job.id;
}

/**
 * Claim one runnable job. The UPDATE ... WHERE status='pending' pattern makes
 * the claim atomic, so multiple workers never pick up the same row.
 */
function claim() {
  const candidate = get(
    `SELECT id FROM jobs WHERE status = 'pending' AND run_after <= ?
     ORDER BY priority ASC, run_after ASC LIMIT 1`,
    [nowIso()],
  );
  if (!candidate) return null;
  const result = run(
    `UPDATE jobs SET status = 'running', locked_at = ?, locked_by = ?, attempts = attempts + 1,
       started_at = COALESCE(started_at, ?), updated_at = ?
     WHERE id = ? AND status = 'pending'`,
    [nowIso(), workerId, nowIso(), nowIso(), candidate.id],
  );
  if (!result.changes) return null;
  return get('SELECT * FROM jobs WHERE id = ?', [candidate.id]);
}

const BACKOFF_SECONDS = [5, 30, 120, 600];

async function runJob(job) {
  const handler = handlers.get(job.type);
  const started = Date.now();
  if (!handler) {
    run(`UPDATE jobs SET status = 'dead', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
      [`No handler registered for "${job.type}"`, nowIso(), nowIso(), job.id]);
    logger.error('job has no handler', { type: job.type, jobId: job.id });
    return;
  }
  let payload = {};
  try {
    payload = JSON.parse(job.payload || '{}');
  } catch {
    payload = {};
  }

  try {
    const result = await handler(payload, job);
    run(`UPDATE jobs SET status = 'succeeded', result = ?, finished_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`,
      [result === undefined ? null : JSON.stringify(result), nowIso(), nowIso(), job.id]);
    logger.debug('job succeeded', { type: job.type, jobId: job.id, ms: Date.now() - started });
  } catch (error) {
    const exhausted = job.attempts >= job.max_attempts;
    if (exhausted) {
      run(`UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
        [error.message, nowIso(), nowIso(), job.id]);
      logger.error('job failed permanently', { type: job.type, jobId: job.id, error: error.message });
    } else {
      const delay = BACKOFF_SECONDS[Math.min(job.attempts - 1, BACKOFF_SECONDS.length - 1)];
      run(`UPDATE jobs SET status = 'pending', last_error = ?, run_after = ?, locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?`,
        [error.message, addSeconds(delay), nowIso(), job.id]);
      logger.warn('job failed, will retry', { type: job.type, jobId: job.id, retryInSeconds: delay, error: error.message });
    }
  }
}

async function tick() {
  if (stopped) return;
  while (running < config.queue.concurrency) {
    const job = claim();
    if (!job) break;
    running += 1;
    runJob(job).finally(() => {
      running -= 1;
    });
  }
}

export function startWorkers() {
  if (!config.queue.enabled || timer) return;
  stopped = false;
  timer = setInterval(() => {
    tick().catch((error) => logger.error('queue tick failed', { error: error.message }));
  }, config.queue.pollIntervalMs);
  timer.unref?.();
  // Requeue jobs abandoned by a previous process crash.
  const recovered = run(
    `UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL WHERE status = 'running' AND locked_at < ?`,
    [addSeconds(-600)],
  );
  logger.info('queue workers started', {
    concurrency: config.queue.concurrency, handlers: handlers.size, recovered: recovered.changes,
  });
}

export function stopWorkers() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

/** Run the queue to completion. Used by tests and the seeder. */
export async function drain({ timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = get(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running') AND run_after <= ?`, [nowIso()]);
    if (!pending?.n && running === 0) return true;
    if (Date.now() > deadline) return false;
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

export function stats(organizationId) {
  const scope = organizationId ? ' WHERE organization_id = ?' : '';
  const params = organizationId ? [organizationId] : [];
  const byStatus = all(`SELECT status, COUNT(*) AS n FROM jobs${scope} GROUP BY status`, params);
  const byType = all(`SELECT type, status, COUNT(*) AS n FROM jobs${scope} GROUP BY type, status`, params);
  return {
    workerId,
    concurrency: config.queue.concurrency,
    inFlight: running,
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    byType,
    handlers: [...handlers.keys()].sort(),
  };
}

export function listJobs({ organizationId, status, limit = 50 } = {}) {
  const params = [];
  let sql = 'SELECT id, type, status, attempts, max_attempts, last_error, run_after, created_at, finished_at FROM jobs WHERE 1=1';
  if (organizationId) {
    sql += ' AND organization_id = ?';
    params.push(organizationId);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return all(sql, params);
}

export function retryJob(jobId) {
  return run(
    `UPDATE jobs SET status = 'pending', attempts = 0, run_after = ?, last_error = NULL, locked_by = NULL WHERE id = ?`,
    [nowIso(), jobId],
  ).changes;
}

export default { enqueue, registerHandler, startWorkers, stopWorkers, drain, stats, listJobs, retryJob, registeredTypes };
