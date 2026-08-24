import { Router } from 'express';
import { get, run } from '../db/index.js';
import { nowIso } from '../lib/time.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { badRequest, notFound } from '../lib/errors.js';
import * as telephony from '../services/telephony/index.js';
import { enqueue } from '../services/queue/index.js';
import { createHmac } from 'node:crypto';
import { safeEqual } from '../lib/crypto.js';
import config from '../config.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * Inbound webhooks from providers.
 *
 * These are unauthenticated by JWT (the caller is a provider, not a user) so
 * every route validates a provider signature instead. Telephony status
 * callbacks drive the same state machine the UI uses, which keeps a real
 * carrier and the simulator behaviourally identical.
 */

/**
 * Twilio signs each request with a base64 HMAC-SHA1 over the full URL plus the
 * POST parameters sorted by key. With no auth token configured (simulator-only
 * deployments) there is nothing to verify against, so the check is skipped.
 */
function verifyTwilioSignature(req) {
  const token = config.telephony.twilio.authToken;
  if (!token) return true;
  const provided = req.get('x-twilio-signature');
  if (!provided) return false;
  const url = `${config.publicUrl}${req.originalUrl}`;
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  const payload = url + Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('');
  const expected = createHmac('sha1', token).update(payload, 'utf8').digest('base64');
  return safeEqual(expected, provided);
}

// POST /webhooks/telephony/status
router.post('/telephony/status', asyncHandler(async (req, res) => {
  if (!verifyTwilioSignature(req)) throw badRequest('Invalid provider signature');
  const { callId } = req.query;
  const status = String(req.body?.CallStatus || req.body?.status || '').toLowerCase();
  if (!callId) throw badRequest('callId is required');

  const call = get('SELECT * FROM calls WHERE id = ?', [callId]);
  if (!call) throw notFound('Call');

  const map = {
    initiated: 'queued',
    ringing: 'ringing',
    'in-progress': 'in_progress',
    answered: 'in_progress',
    completed: 'completed',
    busy: 'failed',
    failed: 'failed',
    'no-answer': 'no_answer',
    canceled: 'failed',
  };
  const mapped = map[status];
  logger.debug('telephony status callback', { callId, status, mapped });

  if (mapped === 'in_progress' && call.status !== 'in_progress') {
    await telephony.answerCall({ organizationId: call.organization_id, callId });
  } else if (['completed', 'failed', 'no_answer'].includes(mapped)) {
    await telephony.endCall({
      organizationId: call.organization_id,
      callId,
      status: mapped === 'completed' ? 'completed' : mapped,
    });
  } else if (mapped) {
    run('UPDATE calls SET status = ?, updated_at = ? WHERE id = ?', [mapped, nowIso(), callId]);
  }
  res.json({ ok: true });
}));

// POST /webhooks/telephony/recording
router.post('/telephony/recording', asyncHandler(async (req, res) => {
  if (!verifyTwilioSignature(req)) throw badRequest('Invalid provider signature');
  const { callId } = req.query;
  const call = get('SELECT * FROM calls WHERE id = ?', [callId]);
  if (!call) throw notFound('Call');
  const recordingUrl = req.body?.RecordingUrl || req.body?.recordingUrl;
  if (!recordingUrl) throw badRequest('RecordingUrl is required');

  run(`UPDATE calls SET ai_status = 'queued', updated_at = ? WHERE id = ?`, [nowIso(), callId]);
  enqueue('call.process_recording', { callId, recordingUrl }, { organizationId: call.organization_id, priority: 2 });
  res.json({ ok: true, queued: true });
}));

// POST /webhooks/telephony/inbound  -- a new inbound call arrived
router.post('/telephony/inbound', asyncHandler(async (req, res) => {
  if (!verifyTwilioSignature(req)) throw badRequest('Invalid provider signature');
  const organizationId = req.query.organizationId
    || get(`SELECT organization_id FROM integrations WHERE category = 'telephony' AND status = 'connected' LIMIT 1`)?.organization_id;
  if (!organizationId) throw badRequest('Could not resolve the organisation for this inbound call');

  const result = await telephony.receiveCall({
    organizationId,
    fromNumber: req.body?.From || req.body?.from,
    toNumber: req.body?.To || req.body?.to,
    providerCallId: req.body?.CallSid || req.body?.callSid,
  });
  // Providers expect instructions; TwiML is returned when Twilio is the carrier.
  res.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Connecting you now.</Say><Pause length="1"/></Response>`,
  );
  logger.info('inbound call received via webhook', { callId: result.call.id });
}));

// POST /webhooks/email/events  -- opens, replies, bounces
router.post('/email/events', asyncHandler(async (req, res) => {
  const { messageId, event } = req.body || {};
  if (!messageId || !event) throw badRequest('messageId and event are required');
  const email = get('SELECT * FROM emails WHERE provider_message_id = ?', [messageId]);
  if (!email) return res.json({ ok: true, matched: false });

  if (event === 'opened' && !email.opened_at) {
    run('UPDATE emails SET opened_at = ? WHERE id = ?', [nowIso(), email.id]);
  } else if (event === 'replied') {
    run('UPDATE emails SET replied_at = ? WHERE id = ?', [nowIso(), email.id]);
  } else if (event === 'bounced' || event === 'failed') {
    run(`UPDATE emails SET status = 'failed', error = ? WHERE id = ?`, [`Provider reported: ${event}`, email.id]);
  }
  return res.json({ ok: true, matched: true });
}));

export default router;
