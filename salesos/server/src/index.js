import config from './config.js';
import logger from './lib/logger.js';
import { createApp } from './app.js';
import { getDb, closeDb } from './db/index.js';
import { startWorkers, stopWorkers } from './services/queue/index.js';
import { registerWorkers } from './services/queue/workers.js';
import { runScheduler } from './services/automation/index.js';

// Database first: a schema problem should stop the process before it accepts traffic.
getDb();
registerWorkers();

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  logger.info('SalesOS API listening', {
    url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
    environment: config.env,
    telephony: config.telephony.provider,
    email: config.email.provider,
    aiProvider: config.ai.provider,
    modelConfigured: Boolean(config.ai.anthropic.apiKey),
  });
});

startWorkers();

// Periodic sweep: reminders, SLA alerts, retention. Runs in-process here; in a
// multi-node deployment this would be a single leader or an external cron.
let schedulerTimer = null;
if (config.scheduler.enabled) {
  schedulerTimer = setInterval(() => {
    try {
      runScheduler();
    } catch (error) {
      logger.error('scheduler failed', { error: error.message });
    }
  }, config.scheduler.intervalMs);
  schedulerTimer.unref();
  logger.info('scheduler started', { intervalMs: config.scheduler.intervalMs });
}

function shutdown(signal) {
  logger.info('shutting down', { signal });
  stopWorkers();
  if (schedulerTimer) clearInterval(schedulerTimer);
  server.close(() => {
    closeDb();
    logger.info('shutdown complete');
    process.exit(0);
  });
  // Do not hang for ever on a stuck connection.
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', { reason: reason?.message || String(reason), stack: reason?.stack });
});
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception', { message: error.message, stack: error.stack });
  shutdown('uncaughtException');
});

export { app, server };
