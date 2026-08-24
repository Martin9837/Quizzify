import config from '../../config.js';
import logger from '../../lib/logger.js';

/**
 * Twilio adapter.
 *
 * Kept intentionally thin: it maps the SalesOS provider interface onto Twilio's
 * REST API. Credentials come from the org integration record or environment.
 * Without credentials every method throws a clear configuration error rather
 * than failing deep inside a call flow.
 */

function credentials() {
  const { accountSid, authToken } = config.telephony.twilio;
  if (!accountSid || !authToken) {
    throw new Error('Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN, or use TELEPHONY_PROVIDER=simulator.');
  }
  return { accountSid, authToken };
}

async function twilioRequest(path, { method = 'POST', form = {} } = {}) {
  const { accountSid, authToken } = credentials();
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}${path}`;
  const body = new URLSearchParams(form).toString();
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: method === 'GET' ? undefined : body,
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Twilio ${method} ${path} failed: ${payload.message || response.status}`);
  }
  return payload;
}

export const twilio = {
  name: 'twilio',
  supportsRecording: true,
  supportsTransfer: true,

  async placeCall({ to, from, callId, recordingEnabled }) {
    const result = await twilioRequest('/Calls.json', {
      form: {
        To: to,
        From: from,
        Url: `${config.publicUrl}/api/v1/webhooks/telephony/twiml?callId=${encodeURIComponent(callId)}`,
        StatusCallback: `${config.publicUrl}/api/v1/webhooks/telephony/status?callId=${encodeURIComponent(callId)}`,
        StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        Record: recordingEnabled ? 'true' : 'false',
        RecordingStatusCallback: `${config.publicUrl}/api/v1/webhooks/telephony/recording?callId=${encodeURIComponent(callId)}`,
      },
    });
    return { providerCallId: result.sid, status: 'ringing' };
  },

  async answer() {
    // Inbound answering is handled by the TwiML application, not the REST API.
    return { status: 'in_progress' };
  },

  async hold(providerCallId, onHold) {
    await twilioRequest(`/Calls/${providerCallId}.json`, {
      form: onHold ? { Status: 'in-progress', Url: `${config.publicUrl}/api/v1/webhooks/telephony/hold` } : { Status: 'in-progress' },
    });
    return { onHold: Boolean(onHold) };
  },

  async mute() {
    // Muting happens client-side in the Twilio Voice SDK.
    return { muted: true, clientSide: true };
  },

  async transfer(providerCallId, destination) {
    await twilioRequest(`/Calls/${providerCallId}.json`, {
      form: { Url: `${config.publicUrl}/api/v1/webhooks/telephony/transfer?to=${encodeURIComponent(destination)}` },
    });
    return { transferredTo: destination, status: 'transferred' };
  },

  async sendDigits(providerCallId, digits) {
    await twilioRequest(`/Calls/${providerCallId}.json`, { form: { SendDigits: digits } });
    return { sent: digits };
  },

  async hangup(providerCallId) {
    await twilioRequest(`/Calls/${providerCallId}.json`, { form: { Status: 'completed' } });
    return { status: 'completed' };
  },

  async fetchRecording({ recordingUrl }) {
    if (!recordingUrl) throw new Error('No recording URL supplied by provider');
    const { accountSid, authToken } = credentials();
    const response = await fetch(recordingUrl, {
      headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` },
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Recording download failed: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    logger.debug('twilio recording fetched', { bytes: buffer.length });
    return { buffer, contentType: response.headers.get('content-type') || 'audio/wav' };
  },
};

export default twilio;
