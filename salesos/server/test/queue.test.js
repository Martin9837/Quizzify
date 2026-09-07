import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop } from './helpers.js';
import { enqueue, registerHandler, drain, reclaimAbandoned, stopWorkers, startWorkers } from '../src/services/queue/index.js';
import { get, run, all } from '../src/db/index.js';
import { addSeconds, nowIso } from '../src/lib/time.js';
import config from '../src/config.js';

before(start);
after(async () => { stopWorkers(); await stop(); });

const status = (jobId) => get('SELECT * FROM jobs WHERE id = ?', [jobId]);

describe('the queue survives a handler that never returns', () => {
  /**
   * A hung handler used to hold its concurrency slot for the life of the
   * process. At the default concurrency of three, three of them stopped the
   * queue outright -- no transcription, no analysis, no follow-ups -- and the
   * 600s abandonment sweep did not help because it only ran inside
   * `startWorkers()`, so recovery meant a restart.
   */
  it('reclaims the slot and lets the work behind it through', async () => {
    // A real deployment waits five minutes; the test waits a fraction of one.
    const saved = config.queue.jobTimeoutMs;
    config.queue.jobTimeoutMs = 400;
    const release = [];
    registerHandler('test.hangs', () => new Promise((resolve) => release.push(resolve)));
    registerHandler('test.finishes', async () => 'done');

    try {
      // Enough hung jobs to fill every slot.
      const hung = [];
      for (let i = 0; i < config.queue.concurrency; i += 1) hung.push(enqueue('test.hangs', { i }));
      const behind = enqueue('test.finishes', {});

      assert.equal(await drain({ timeoutMs: 15000 }), true, 'the queue never drained');
      assert.equal(
        status(behind).status,
        'succeeded',
        'a job queued behind the hung handlers never ran, so the queue was blocked',
      );
      for (const jobId of hung) {
        const job = status(jobId);
        assert.notEqual(job.status, 'running', `job ${jobId} is still holding a slot`);
        assert.match(
          job.last_error,
          /did not finish within/,
          `a timed-out job should say so, got ${JSON.stringify(job.last_error)}`,
        );
      }
    } finally {
      config.queue.jobTimeoutMs = saved;
      release.forEach((resolve) => resolve());
    }
  });

  it('requeues a job whose worker went away, without waiting for a restart', async () => {
    registerHandler('test.plain', async () => 'ok');
    const orphan = enqueue('test.plain', {});
    // Exactly the state a killed process leaves behind.
    run("UPDATE jobs SET status = 'running', locked_at = ?, locked_by = 'w_gone' WHERE id = ?",
      [addSeconds(-(config.queue.abandonAfterSeconds + 60)), orphan]);

    assert.equal(reclaimAbandoned() >= 1, true, 'the sweep found nothing to reclaim');
    assert.equal(status(orphan).status, 'pending');
    assert.equal(status(orphan).locked_by, null, 'a reclaimed job must not keep the dead worker lock');

    await drain({ timeoutMs: 10000 });
    assert.equal(status(orphan).status, 'succeeded');
  });

  it('leaves a job that is merely slow alone', async () => {
    const orphan = enqueue('test.plain', {});
    // Locked recently: still someone else's work, not abandoned.
    run("UPDATE jobs SET status = 'running', locked_at = ?, locked_by = 'w_busy' WHERE id = ?",
      [nowIso(), orphan]);
    reclaimAbandoned();
    assert.equal(status(orphan).status, 'running', 'the sweep stole a job that was still being worked on');
    run("UPDATE jobs SET status = 'succeeded' WHERE id = ?", [orphan]);
  });
});

describe('queue delivery guarantees', () => {
  it('retries with growing backoff and then stops at max_attempts', async () => {
    let attempts = 0;
    registerHandler('test.fails', async () => { attempts += 1; throw new Error('deliberate'); });
    const job = enqueue('test.fails', {}, { maxAttempts: 3 });

    const delays = [];
    for (let i = 0; i < 5; i += 1) {
      await drain({ timeoutMs: 8000 });
      const row = status(job);
      if (row.status !== 'pending') break;
      delays.push(Math.round((new Date(row.run_after) - new Date(row.updated_at)) / 1000));
      run('UPDATE jobs SET run_after = ? WHERE id = ?', [nowIso(), job]);
    }

    assert.deepEqual(delays, [5, 30], `backoff should grow, observed ${JSON.stringify(delays)}`);
    const row = status(job);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 3, 'a job must not be retried past max_attempts');
    assert.equal(attempts, 3, 'the handler ran a different number of times than the row records');
    assert.ok(row.last_error, 'the failure reason must be kept for whoever looks');
  });

  it('marks a job with no handler dead rather than retrying it forever', async () => {
    const job = enqueue('test.nobody-handles-this', {});
    await drain({ timeoutMs: 5000 });
    assert.equal(status(job).status, 'dead');
    assert.match(status(job).last_error, /No handler registered/);
  });

  it('never exceeds the configured concurrency, and loses nothing under load', async () => {
    let inFlight = 0;
    let peak = 0;
    registerHandler('test.slow', async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
    });
    const jobs = [];
    for (let i = 0; i < 20; i += 1) jobs.push(enqueue('test.slow', { i }));

    assert.equal(await drain({ timeoutMs: 30000 }), true);
    assert.ok(peak <= config.queue.concurrency, `ran ${peak} at once with a limit of ${config.queue.concurrency}`);
    const succeeded = all(
      "SELECT id FROM jobs WHERE type = 'test.slow' AND status = 'succeeded'",
    ).length;
    assert.equal(succeeded, jobs.length, `${succeeded}/${jobs.length} completed`);
  });

  it('recovers abandoned jobs when the process starts, not just while it runs', async () => {
    const orphan = enqueue('test.plain', {});
    run("UPDATE jobs SET status = 'running', locked_at = ?, locked_by = 'w_crashed' WHERE id = ?",
      [addSeconds(-(config.queue.abandonAfterSeconds + 60)), orphan]);
    const wasEnabled = config.queue.enabled;
    config.queue.enabled = true;
    try {
      startWorkers();
      assert.equal(status(orphan).status, 'pending');
    } finally {
      stopWorkers();
      config.queue.enabled = wasEnabled;
    }
    await drain({ timeoutMs: 10000 });
  });
});
