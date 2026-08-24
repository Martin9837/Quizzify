import { id } from '../../lib/ids.js';
import { nowIso } from '../../lib/time.js';
import logger from '../../lib/logger.js';

/**
 * In-process softphone simulator.
 *
 * Implements the full provider interface so the entire call -> recording ->
 * transcript -> AI pipeline is exercisable without a telephony account. Ring
 * outcomes are derived deterministically from the destination number so demos
 * and tests are reproducible.
 */

const active = new Map(); // providerCallId -> state

function outcomeFor(toNumber) {
  const digits = String(toNumber || '').replace(/\D/g, '');
  const bucket = digits ? Number(digits.slice(-2)) % 10 : 0;
  if (bucket === 0) return 'no_answer';
  if (bucket === 1) return 'voicemail';
  if (bucket === 2) return 'busy';
  return 'answered';
}

export const simulator = {
  name: 'simulator',
  supportsRecording: true,
  supportsTransfer: true,

  async placeCall({ to, from, callId, recordingEnabled }) {
    const providerCallId = id('simcall');
    const projected = outcomeFor(to);
    active.set(providerCallId, {
      callId, to, from, recordingEnabled, projected, startedAt: nowIso(), muted: false, onHold: false,
    });
    logger.debug('simulator dial', { providerCallId, to, projected });
    // Ring duration between 2 and 5 seconds keeps the UI honest.
    return { providerCallId, status: 'ringing', ringSeconds: 2 + (Number(String(to).replace(/\D/g, '').slice(-1)) % 4), projectedOutcome: projected };
  },

  async answer(providerCallId) {
    const state = active.get(providerCallId);
    if (!state) return { status: 'failed' };
    state.answeredAt = nowIso();
    return { status: 'in_progress', answeredAt: state.answeredAt };
  },

  async hold(providerCallId, onHold) {
    const state = active.get(providerCallId);
    if (state) state.onHold = onHold;
    return { onHold: Boolean(onHold) };
  },

  async mute(providerCallId, muted) {
    const state = active.get(providerCallId);
    if (state) state.muted = muted;
    return { muted: Boolean(muted) };
  },

  async transfer(providerCallId, destination) {
    const state = active.get(providerCallId);
    if (state) state.transferredTo = destination;
    return { transferredTo: destination, status: 'transferred' };
  },

  async sendDigits(providerCallId, digits) {
    return { sent: String(digits).replace(/[^0-9*#]/g, '') };
  },

  async hangup(providerCallId) {
    const state = active.get(providerCallId);
    active.delete(providerCallId);
    return { status: 'completed', endedAt: nowIso(), state };
  },

  /**
   * Produces a synthetic audio payload standing in for the provider recording.
   * A real provider returns a URL we fetch; the shape of the result is the same
   * so the recording pipeline is provider-agnostic.
   */
  async fetchRecording({ providerCallId, durationSeconds }) {
    const seconds = Math.max(1, durationSeconds || 1);
    const header = Buffer.from(`SALESOS-SIM-AUDIO v1 call=${providerCallId} seconds=${seconds}\n`);
    // ~1 KB per second stand-in payload keeps demo storage small but realistic.
    const body = Buffer.alloc(seconds * 1024, 0x33);
    return { buffer: Buffer.concat([header, body]), contentType: 'audio/simulated', durationSeconds: seconds };
  },
};

export default simulator;
