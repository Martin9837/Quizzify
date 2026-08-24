import { all, insert, run, parseJson } from '../db/index.js';
import { id } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { hmac } from '../lib/crypto.js';
import { enqueue } from './queue/index.js';
import logger from '../lib/logger.js';

/**
 * Outbound webhook framework. Dispatch is always asynchronous and signed with
 * HMAC-SHA256 over `timestamp.body` so receivers can verify authenticity and
 * reject replays.
 */
export function dispatch(organizationId, event, payload) {
  const hooks = all('SELECT * FROM webhooks WHERE organization_id = ? AND enabled = 1', [organizationId])
    .filter((hook) => {
      const events = parseJson(hook.events, []);
      return events.includes('*') || events.includes(event);
    });
  for (const hook of hooks) {
    enqueue('webhook.deliver', { webhookId: hook.id, event, payload }, { organizationId, priority: 7 });
  }
  return hooks.length;
}

export function signature(secret, timestamp, body) {
  return `t=${timestamp},v1=${hmac(`${timestamp}.${body}`, secret)}`;
}

export async function deliver({ webhookId, event, payload, attempt = 1 }) {
  const hook = all('SELECT * FROM webhooks WHERE id = ?', [webhookId])[0];
  if (!hook || !hook.enabled) return { skipped: true };

  const body = JSON.stringify({ id: id('evt'), event, createdAt: nowIso(), data: payload });
  const timestamp = Math.floor(Date.now() / 1000);
  let statusCode = null;
  let error = null;

  try {
    const response = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SalesOS-Webhooks/1.0',
        'X-SalesOS-Event': event,
        'X-SalesOS-Signature': signature(hook.secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    statusCode = response.status;
    if (!response.ok) error = `HTTP ${response.status}`;
  } catch (err) {
    error = err.message;
  }

  insert('webhook_deliveries', {
    id: id('whd'),
    organization_id: hook.organization_id,
    webhook_id: hook.id,
    event,
    payload: body,
    status_code: statusCode,
    error,
    attempt,
    created_at: nowIso(),
  });

  if (error) {
    run('UPDATE webhooks SET failure_count = failure_count + 1, last_status = ? WHERE id = ?', [statusCode, hook.id]);
    // Auto-disable a permanently broken endpoint rather than retrying forever.
    const updated = all('SELECT failure_count FROM webhooks WHERE id = ?', [hook.id])[0];
    if (updated && updated.failure_count >= 20) {
      run('UPDATE webhooks SET enabled = 0 WHERE id = ?', [hook.id]);
      logger.warn('webhook auto-disabled after repeated failures', { webhookId: hook.id });
    }
    throw new Error(`Webhook delivery failed: ${error}`);
  }

  run('UPDATE webhooks SET failure_count = 0, last_status = ?, last_delivered_at = ? WHERE id = ?',
    [statusCode, nowIso(), hook.id]);
  return { statusCode };
}

export default { dispatch, deliver, signature };
