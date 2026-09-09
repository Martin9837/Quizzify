import { DurableObject } from 'cloudflare:workers';
import { setDriver } from '../../../server/src/db/index.js';
import { createDurableObjectDriver } from '../../../server/src/db/driver.do.js';
import { createApp } from '../../../server/src/app.js';
import { registerWorkers } from '../../../server/src/services/queue/workers.js';
import { drain } from '../../../server/src/services/queue/index.js';
import { get } from '../../../server/src/db/index.js';
import { purgeDemoData, resetSurvivorProfile } from '../../../server/src/db/purge.js';
import logger from '../../../server/src/lib/logger.js';
import { createExpressBridge } from './bridge.js';
import schema from '../../../server/src/db/schema.sql';

/**
 * The SalesOS API as a single Durable Object.
 *
 * One object holds the whole application, which is deliberate: it is the shape
 * the server already has. One SQLite database, one job runner, one rate
 * limiter, one connection registry -- all of which assume a single process,
 * and a Durable Object is single-threaded, so they keep being correct.
 *
 * Sharding by organisation later is a routing change (`getByName(orgId)`) that
 * the schema already permits, since every business table carries an
 * organization_id. It is not the first step: it turns the two cross-organisation
 * sweeps in services/automation into a fan-out.
 */

/** Environment variables reach a Worker through `env`, not `process.env`. */
function adoptEnv(env) {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export class SalesOsApi extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    adoptEnv(env);

    // Installed before anything reads, so no call site ever sees node:sqlite.
    setDriver(createDurableObjectDriver(ctx.storage, { schema }));
    registerWorkers();

    this.app = createApp();
    this.serve = createExpressBridge(this.app);

    // The documented way to initialise a Durable Object: it defers every
    // incoming request until this finishes, so nothing can observe a
    // half-seeded database. A memoised promise awaited from fetch() is not
    // equivalent -- input gates protect storage calls, but awaiting other async
    // work (the dynamic import, the seeder's own awaits) opens the gate and
    // lets the next request interleave.
    //
    // Nothing in here may throw: a callback that rejects aborts the object, so
    // a failed seed would take the entire application down rather than leaving
    // it merely empty. An unseeded deployment is recoverable; a dead one is not.
    ctx.blockConcurrencyWhile(async () => {
      try {
        await this.ensureAlarm();
      } catch (error) {
        logger.error('could not schedule the queue alarm', { error: error.message });
      }
      try {
        await this.ensureBootstrapped();
      } catch (error) {
        logger.error('bootstrap failed; the deployment will start empty', { error: error.message });
      }
      try {
        await this.applyPurgeIfRequested();
      } catch (error) {
        // A failed purge leaves the data exactly as it was, which is the safe
        // direction to fail in.
        logger.error('purge failed; the data is unchanged', { error: error.message });
      }
    });
  }

  /** The queue is driven by an alarm: a Durable Object has no interval that
   *  survives, and `setInterval` blocks hibernation while it does run. */
  async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  async alarm() {
    try {
      await drain({ timeoutMs: 25_000 });
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  /**
   * Run the scheduled work. An RPC method rather than a URL: reached through a
   * path, `/__cron` was a public, unauthenticated trigger for background work
   * on the deployed Worker, because the entry handler forwards every request
   * here. A method on the object cannot be addressed over HTTP at all.
   */
  async runScheduled() {
    await drain({ timeoutMs: 25_000 });
    return { drained: true };
  }

  /**
   * Give a fresh deployment something to sign in to.
   *
   * A deployed Worker starts with an empty database and no way to create the
   * first account -- the seeder is a CLI entry point and there is no shell --
   * so the URL would serve a login page that nobody could ever get past.
   *
   * Three conditions, all required, and it is a no-op once any of them fails:
   *
   *   - `SALESOS_BOOTSTRAP=demo` is set, so it never happens by accident.
   *   - The database has no organisations, so it can never touch real data.
   *     This is the load-bearing one: after the first run it can never fire
   *     again, whatever the configuration says.
   *   - `DEMO_PASSWORD` is set explicitly. The seeder's default is published in
   *     this repository, and a public URL must not have accounts on it.
   */
  async ensureBootstrapped() {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    if (this.env.SALESOS_BOOTSTRAP !== 'demo') return;

    if (get('SELECT COUNT(*) AS n FROM organizations')?.n) return;

    if (!process.env.DEMO_PASSWORD) {
      logger.error('SALESOS_BOOTSTRAP is set but DEMO_PASSWORD is not; refusing to '
        + 'create accounts on the password published in the repository');
      return;
    }

    const { seed } = await import('../../../server/src/db/seed.js');
    const result = await seed({ reset: false });
    logger.info('bootstrapped a demo organisation', {
      organization: result?.organization, users: result?.users, leads: result?.leads,
    });
  }

  /**
   * Remove the demo data, once.
   *
   * Gated on a token rather than a boolean, and the token last applied is
   * recorded in the object's key-value storage -- which the purge itself does
   * not touch. Redeploying with the same value does nothing; a purge happens
   * again only when someone deliberately changes the token.
   *
   * That matters more later than it does now. Today this deployment holds
   * nothing but seed data, but the same switch left armed as a boolean would
   * empty a real database on every cold start.
   */
  async applyPurgeIfRequested() {
    const token = this.env.SALESOS_PURGE;
    if (!token) return;

    const applied = await this.ctx.storage.get('salesos:purgeToken');
    if (applied === token) return;

    const options = {
      // Named explicitly: without it the purge keeps the highest-ranking
      // admin, which on a seeded database is not the account anyone signs in
      // with -- so the cleanup would succeed and lock the operator out.
      keepUserEmail: this.env.SALESOS_KEEP_EMAIL || undefined,
      organizationName: this.env.SALESOS_ORG_NAME || undefined,
      adminName: this.env.SALESOS_ADMIN_NAME || undefined,
    };

    // A second token does NOT empty the database again. The demo records went
    // with the first one; anything here now was created by the operator, and a
    // later token -- raised to finish cleaning the two rows the first pass left
    // half-seeded -- must not take their work with it. Only a deployment that
    // has never purged deletes anything.
    const result = applied ? resetSurvivorProfile(options) : purgeDemoData(options);
    // Recorded only after it succeeded, so a failure is retried on the next
    // start rather than being silently marked done.
    await this.ctx.storage.put('salesos:purgeToken', token);
    logger.info(applied ? 'surviving account reset on request' : 'demo data purged on request',
      { token, keptUser: result.keptUser.email });
  }

  async fetch(request) {
    return this.serve(request);
  }
}

export default {
  fetch(request, env) {
    // A single object for the whole application; see the note above.
    return env.API.getByName('salesos').fetch(request);
  },

  /** Cron replaces the four setInterval scheduler loops. */
  async scheduled(controller, env) {
    adoptEnv(env);
    await env.API.getByName('salesos').runScheduled();
  },
};
