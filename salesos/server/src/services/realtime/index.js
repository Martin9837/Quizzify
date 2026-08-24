import logger from '../../lib/logger.js';
import { id } from '../../lib/ids.js';

/**
 * Server-Sent Events hub.
 *
 * Chosen over WebSockets because every payload here is server -> client and SSE
 * survives proxies, reconnects automatically, and needs no extra dependency.
 * Clients are keyed by organisation so a tenant can never receive another
 * tenant's stream, and per-user targeting is supported for notifications.
 */
const clients = new Map(); // clientId -> { res, userId, organizationId, role }

function write(client, event, data) {
  try {
    client.res.write(`event: ${event}\n`);
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (error) {
    logger.debug('sse write failed', { error: error.message });
  }
}

export function subscribe(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const clientId = id('sse');
  const client = { res, userId: user.id, organizationId: user.organizationId, role: user.role };
  clients.set(clientId, client);
  write(client, 'connected', { clientId, serverTime: new Date().toISOString() });

  // Comment frames keep intermediaries from closing an idle connection.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(clientId);
    logger.debug('sse disconnected', { clientId, connections: clients.size });
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  logger.debug('sse connected', { clientId, userId: user.id, connections: clients.size });
}

/** Broadcast to every connection in an organisation. */
export function emitToOrg(organizationId, event, data) {
  for (const client of clients.values()) {
    if (client.organizationId === organizationId) write(client, event, data);
  }
}

/** Send to a single user (all of their open tabs). */
export function emitToUser(userId, event, data) {
  for (const client of clients.values()) {
    if (client.userId === userId) write(client, event, data);
  }
}

export function emitToUsers(userIds, event, data) {
  const set = new Set(userIds);
  for (const client of clients.values()) {
    if (set.has(client.userId)) write(client, event, data);
  }
}

/** Managers and above in an organisation -- used for team-level alerts. */
export function emitToManagers(organizationId, event, data) {
  for (const client of clients.values()) {
    if (client.organizationId === organizationId && client.role !== 'agent') write(client, event, data);
  }
}

export const connectionCount = () => clients.size;

export default { subscribe, emitToOrg, emitToUser, emitToUsers, emitToManagers, connectionCount };
