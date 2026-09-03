import logger from '../../lib/logger.js';

/**
 * Device provider -- the call happens on the agent's own handset.
 *
 * The mobile app hands the number to the system dialer and the conversation runs
 * over the carrier, so there is nothing for the server to dial, hold, mute or
 * hang up. Everything else about the call is unchanged: the CRM record, the lead
 * and deal association, the do-not-call check, the consent state and the activity
 * log are all created exactly as for a provider call, which is the point -- a call
 * made this way still lands in the CRM.
 *
 * What is genuinely lost is the audio. iOS gives an app no access to the carrier
 * call, so there is no recording, and therefore no transcript, no analysis and no
 * AI-extracted CRM updates. endCall() already surfaces that honestly as
 * skipReason 'not_recorded'.
 *
 * The methods below return shapes matching the other providers rather than
 * throwing, so shared call handling needs no special cases. They deliberately do
 * not pretend to have done anything: the carrier reports nothing back, so the
 * agent is the only source of truth for what happened, and they supply it when
 * they end the call.
 */
export const device = {
  name: 'device',
  supportsRecording: false,
  supportsTransfer: false,

  async placeCall({ to, callId }) {
    logger.debug('device dial handed to the handset', { callId });
    // No ring simulation and no projected outcome: this provider has no idea
    // what the carrier is doing, and guessing would put fiction in the CRM.
    return { providerCallId: `device:${callId}`, status: 'ringing', ringSeconds: 0, projectedOutcome: null, dialNumber: to };
  },

  // The handset owns the call from here. These exist so the shared control paths
  // resolve; none of them can affect a carrier call.
  async answer() { return { status: 'in_progress' }; },
  async hold() { return { onHold: false, unsupported: true }; },
  async mute() { return { muted: false, unsupported: true }; },
  async transfer() { return { transferred: false, unsupported: true }; },
  async sendDigits() { return { sent: false, unsupported: true }; },
  async hangup() { return { status: 'completed' }; },
  async fetchRecording() { return null; },
};

export default device;
