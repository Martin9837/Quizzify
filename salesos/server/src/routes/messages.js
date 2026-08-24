import { Router } from 'express';
import { all, get, insert } from '../db/index.js';
import { id } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { validate } from '../lib/validate.js';
import { notFound, badRequest, forbidden } from '../lib/errors.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requirePermission, assertRecordAccess } from '../middleware/auth.js';
import { toE164 } from '../lib/phone.js';
import * as activityService from '../services/activity.js';
import { orgSettings } from '../services/org.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * SMS / WhatsApp.
 *
 * Messaging carries stricter consent rules than calling: a contact must have
 * opted in or have an existing relationship, and a do-not-contact flag blocks
 * the channel outright. The provider is pluggable; without one configured the
 * message is recorded as queued so the audit trail is still complete.
 */

// GET /messages?leadId=
router.get('/', requirePermission('message:send'), asyncHandler(async (req, res) => {
  if (!req.query.leadId) throw badRequest('leadId is required');
  res.json({
    messages: all('SELECT * FROM messages WHERE organization_id = ? AND lead_id = ? ORDER BY created_at DESC LIMIT 100',
      [req.auth.organizationId, req.query.leadId]),
  });
}));

// POST /messages
router.post('/', requirePermission('message:send'), asyncHandler(async (req, res) => {
  const data = validate(req.body, {
    leadId: { type: 'string', required: true, maxLength: 40 },
    channel: { type: 'string', enum: ['sms', 'whatsapp'], default: 'sms' },
    body: { type: 'string', required: true, maxLength: 1600 },
  });
  const lead = get('SELECT * FROM leads WHERE id = ? AND organization_id = ?', [data.leadId, req.auth.organizationId]);
  if (!lead) throw notFound('Lead');
  assertRecordAccess(req, lead.owner_id);
  if (lead.do_not_call) throw forbidden('This contact is marked do-not-contact');
  if (!lead.phone_e164) throw badRequest('This contact has no phone number on file');

  const integration = get(
    `SELECT provider, status FROM integrations WHERE organization_id = ? AND category = 'messaging' AND status = 'connected' LIMIT 1`,
    [req.auth.organizationId],
  );

  // Consent basis is recorded on every message so an audit can reconstruct why
  // the organisation believed it was permitted to send.
  const consentBasis = lead.consent_recording === 'granted' ? 'opt_in'
    : lead.last_contacted_at ? 'existing_relationship' : 'blocked';
  if (consentBasis === 'blocked') {
    throw forbidden('No messaging consent on file for this contact. Call or email first, or capture an opt-in.');
  }

  const row = {
    id: id('msg'),
    organization_id: req.auth.organizationId,
    lead_id: lead.id,
    user_id: req.auth.userId,
    channel: data.channel,
    direction: 'outbound',
    to_number: toE164(lead.phone_e164),
    from_number: null,
    body: data.body,
    status: integration ? 'queued' : 'queued',
    provider: integration?.provider || null,
    consent_basis: consentBasis,
    created_at: nowIso(),
  };
  insert('messages', row);
  if (!integration) {
    logger.info('message recorded without a connected provider', { channel: data.channel, leadId: lead.id });
  }

  activityService.log({
    organizationId: req.auth.organizationId,
    leadId: lead.id,
    actorId: req.auth.userId,
    type: data.channel,
    refId: row.id,
    title: `${data.channel.toUpperCase()} sent`,
    body: data.body,
    metadata: { consentBasis, provider: integration?.provider || 'none' },
  });

  res.status(201).json({
    message: row,
    providerConnected: Boolean(integration),
    note: integration ? undefined : 'No messaging provider is connected. The message is logged but not delivered.',
  });
}));

export default router;
