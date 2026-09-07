import { DurableObject } from 'cloudflare:workers';
import { setDriver } from '../../../server/src/db/index.js';
import { createDurableObjectDriver } from '../../../server/src/db/driver.do.js';
import { createApp } from '../../../server/src/app.js';
import { registerWorkers } from '../../../server/src/services/queue/workers.js';
import { drain } from '../../../server/src/services/queue/index.js';
import { get } from '../../../server/src/db/index.js';
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
    this.booted = false;
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
   * Load the demo organisation, for trying the deployment out.
   *
   * Two conditions, both required: an explicit opt-in variable, and an
   * environment that is not production. The seed creates four accounts on a
   * published password, so it must not be reachable on anything real -- the
   * committed configuration never sets the variable.
   */
  async seedDemoData() {
    if (this.env.SALESOS_ALLOW_DEMO_SEED !== 'true') {
      return Response.json({ error: 'not enabled' }, { status: 404 });
    }
    if ((this.env.NODE_ENV || process.env.NODE_ENV) === 'production') {
      return Response.json({ error: 'refused in production' }, { status: 403 });
    }
    const existing = get('SELECT COUNT(*) AS n FROM organizations')?.n || 0;
    if (existing) return Response.json({ skipped: true, organizations: existing });
    const { seed } = await import('../../../server/src/db/seed.js');
    const result = await seed({ reset: false });
    return Response.json({ seeded: true, result });
  }

  async fetch(request) {
    if (!this.booted) {
      this.booted = true;
      await this.ensureAlarm();
    }
    const url = new URL(request.url);
    if (url.pathname === '/__seed') return this.seedDemoData();
    if (url.pathname === '/__cron') {
      await drain({ timeoutMs: 25_000 });
      return Response.json({ ok: true });
    }
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
    const stub = env.API.getByName('salesos');
    await stub.fetch(new Request('https://salesos.internal/__cron', { method: 'POST' }));
  },
};
