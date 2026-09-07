import config from '../../config.js';
import logger from '../../lib/logger.js';

/**
 * Transcription engine.
 *
 * Two engines share one interface:
 *
 *  - `external`: posts the recording to a speech-to-text service (Whisper,
 *    Deepgram, AssemblyAI, ...) and maps the response into our segment shape.
 *    Enabled by setting STT_URL/STT_API_KEY.
 *
 *  - `local`: the default. Simulator recordings contain no real speech, so this
 *    engine synthesises a realistic, deterministic sales conversation from the
 *    CRM context of the call. That keeps the whole pipeline -- diarisation,
 *    analysis, extraction, suggestions, email drafting -- exercisable end to end
 *    without a telephony or STT account. It is clearly labelled as `local` on
 *    every transcript it produces so nobody mistakes it for real audio.
 */

// -------------------------------------------------------------- helpers -----
function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic PRNG so the same call always transcribes the same way. */
function rng(seed) {
  let a = hash32(seed);
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];

// ---------------------------------------------------------- scenario data ---
const SCENARIOS = {
  discovery: { objection: 'budget', signals: 'moderate', stage: 'qualified' },
  demo_recap: { objection: 'features', signals: 'strong', stage: 'demo' },
  pricing: { objection: 'pricing', signals: 'strong', stage: 'proposal' },
  negotiation: { objection: 'contract_terms', signals: 'strong', stage: 'negotiation' },
  cold_intro: { objection: 'timing', signals: 'weak', stage: 'contacted' },
  stalled: { objection: 'status_quo', signals: 'weak', stage: 'discovery' },
};

function scenarioForStage(stage, rand) {
  const byStage = {
    new_lead: 'cold_intro',
    contacted: 'cold_intro',
    qualified: 'discovery',
    discovery: 'discovery',
    demo: 'demo_recap',
    proposal: 'pricing',
    negotiation: 'negotiation',
  };
  const base = byStage[stage] || (rand() > 0.5 ? 'discovery' : 'cold_intro');
  // Occasionally a deal stalls regardless of stage -- keeps demo data varied.
  return rand() > 0.85 ? 'stalled' : base;
}

const COMPETITORS = ['Salesloft', 'Outreach', 'HubSpot', 'Gong', 'Chorus', 'Zoho', 'Pipedrive'];
const PAIN_POINTS = [
  'reps spend the first hour of every day updating the CRM instead of selling',
  'call notes are inconsistent so managers cannot coach from them',
  'follow-ups get missed when a rep has more than forty open opportunities',
  'nobody can tell which objections are actually costing us deals',
  'handovers between SDR and AE lose half the context from discovery',
];
const REQUIREMENTS = [
  'single sign-on with Okta',
  'call recording that respects two-party consent states',
  'a Salesforce two-way sync',
  'role-based access so reps only see their own pipeline',
  'exportable reports for the quarterly business review',
  'data residency in the EU',
];

// ------------------------------------------------------ dialogue builder ----
function buildDialogue({ scenario, lead, deal, agentName, rand, targetSeconds }) {
  const contact = lead?.first_name || 'there';
  const company = lead?.company_name || 'your team';
  const product = deal?.product || 'the platform';
  const seats = 20 + Math.floor(rand() * 180);
  const budget = [15000, 18000, 25000, 32000, 40000, 55000, 78000][Math.floor(rand() * 7)];
  const competitor = pick(rand, COMPETITORS);
  const pain = pick(rand, PAIN_POINTS);
  const pain2 = pick(rand, PAIN_POINTS.filter((p) => p !== pain));
  const requirement = pick(rand, REQUIREMENTS);
  const requirement2 = pick(rand, REQUIREMENTS.filter((r) => r !== requirement));
  const decisionMaker = pick(rand, ['our VP of Sales, Dana Whitfield', 'our CRO, Marcus Lee', 'the CFO', 'our COO, Priya Raman']);
  const weeks = 2 + Math.floor(rand() * 8);

  const turns = [];
  const say = (role, text) => turns.push({ role, text });

  say('agent', `Hi ${contact}, thanks for making the time. Can you still hear me clearly?`);
  say('customer', 'Yes, loud and clear.');
  say('agent', 'Before we start — I have recording on for my notes so I can send you an accurate summary afterwards. Are you comfortable with that?');
  say('customer', 'That is fine.');

  if (scenario === 'cold_intro') {
    say('agent', `I will keep this to ten minutes. I work with revenue teams around ${company}'s size, and the pattern I keep hearing is that ${pain}. Does that land at all for you?`);
    say('customer', `Somewhat. Honestly the bigger issue for us is that ${pain2}. But I will be upfront, we are mid-way through another rollout so timing is awkward.`);
    say('agent', 'Understood. What is the rollout?');
    say('customer', `We are moving the support team onto a new helpdesk. That takes us through to the end of the quarter, realistically ${weeks} weeks.`);
    say('agent', `That is useful to know. Rather than push now, would it make sense to look at this properly once the helpdesk work is done? I can put ${weeks} weeks out in the diary and send you a short overview in the meantime.`);
    say('customer', 'Yes, do that. Send the overview and we can pick it up then.');
    say('agent', `I will. One last thing — when you do evaluate, who else is in the room?`);
    say('customer', `It would be me and ${decisionMaker}. We would want to see the security review early because ${requirement} is non-negotiable for us.`);
    say('agent', `Noted. I will include the security pack. Anything you are already looking at?`);
    say('customer', `We had a demo of ${competitor} last year. It did not go anywhere.`);
  } else if (scenario === 'discovery') {
    say('agent', `Last time we spoke you mentioned ${pain}. I want to understand what that actually costs you today.`);
    say('customer', `It is real. We have ${seats} reps and each of them loses maybe forty minutes a day on admin. On top of that ${pain2}.`);
    say('agent', 'If we fixed the admin time, what would you do with it?');
    say('customer', 'More conversations, obviously. Our reps are at about eight calls a day and should be at fourteen.');
    say('agent', `Makes sense. What does the evaluation process look like on your side?`);
    say('customer', `I can recommend, but ${decisionMaker} signs it off. We have budget set aside — around ${budget.toLocaleString('en-US')} dollars for the year, maybe a bit more if the case is strong.`);
    say('agent', `That is in the right range for ${seats} seats. What has to be true for this to be an easy yes?`);
    say('customer', `Two things. We need ${requirement}, and we need ${requirement2}. Without those it will not clear our review.`);
    say('agent', `Both are supported — I will confirm the detail in writing. On timing, when would you want to be live?`);
    say('customer', `Realistically within ${weeks} weeks. Our new fiscal year starts after that and I would rather not carry the old process into it.`);
    say('agent', `Then let us aim for a working session with ${decisionMaker} next week, and I will send a short summary and the security pack tomorrow.`);
    say('customer', 'That works. Send it across and I will get it in the diary.');
  } else if (scenario === 'demo_recap') {
    say('agent', `Thanks again for bringing the team to the demo. What stood out for you?`);
    say('customer', `The automatic CRM updates. That is the piece that would actually change behaviour, because right now ${pain}.`);
    say('agent', 'That is the part most teams underestimate. Was anything missing?');
    say('customer', `Two gaps. We need ${requirement}, and reporting needs to roll up by region — right now it looked flat.`);
    say('agent', 'Regional roll-up is configurable, I will show you that. The other one I will confirm with our platform team today.');
    say('customer', `Please do. If those two land we are in good shape. ${decisionMaker} was in the demo and came out positive.`);
    say('agent', `Good to hear. What is the process from here?`);
    say('customer', `Send us a proposal for ${seats} seats. We have roughly ${budget.toLocaleString('en-US')} dollars allocated. If it comes in near that, we can move inside ${weeks} weeks.`);
    say('agent', 'I will have the proposal with you tomorrow, with the regional reporting screenshot included.');
    say('customer', `Great. We are also finishing a look at ${competitor}, just so you know, but you are ahead on the automation piece.`);
    say('agent', 'Appreciated. I will make the comparison explicit in the proposal so your team does not have to do that work.');
  } else if (scenario === 'pricing') {
    say('agent', `You have had the proposal a few days — what is the reaction internally?`);
    say('customer', `The product is not the problem. The price is. It came in at ${(budget * 1.4).toLocaleString('en-US')} dollars and we had ${budget.toLocaleString('en-US')} in the plan.`);
    say('agent', 'Thank you for being direct. Is that a budget ceiling, or a value question?');
    say('customer', `A ceiling. ${decisionMaker} will not sign above it this year. And frankly ${competitor} quoted us lower.`);
    say('agent', `Understood. Two options: we scope to the ${seats} seats that get the most value now and phase the rest next fiscal year, or we keep the full rollout and move to annual prepay, which changes the number materially.`);
    say('customer', 'The phased option is more realistic. What would that look like?');
    say('agent', `Roughly ${budget.toLocaleString('en-US')} for year one covering the core team, same functionality, with the expansion priced now so it does not move on you.`);
    say('customer', `That I can take to ${decisionMaker}. Put it in writing and include ${requirement} confirmation — legal asked about it.`);
    say('agent', `I will send the revised proposal today. Are we still aiming to close inside ${weeks} weeks?`);
    say('customer', 'If the numbers work, yes. I would like it signed before the quarter ends.');
  } else if (scenario === 'negotiation') {
    say('agent', 'Where are we on the redlines?');
    say('customer', `Two open items. The auto-renewal clause needs to go, and we need a thirty-day termination for convenience. Also ${requirement} has to be in the contract, not just the docs.`);
    say('agent', 'Removing auto-renewal is doable. Termination for convenience at thirty days is not standard on an annual — sixty I can get signed off today.');
    say('customer', 'Sixty is probably acceptable. I will check with legal.');
    say('agent', `On commercials, we are at ${budget.toLocaleString('en-US')} for ${seats} seats. Anything else outstanding?`);
    say('customer', `No, the number is agreed. ${decisionMaker} has approved it subject to the contract changes.`);
    say('agent', `Then I will send the revised paper today with auto-renewal removed, sixty-day termination, and ${requirement} written into the schedule.`);
    say('customer', `Do that and we should be able to sign this week. I would like to be live within ${weeks} weeks of signature.`);
    say('agent', 'That timeline is realistic. I will introduce you to onboarding as soon as we are signed.');
  } else {
    say('agent', `I wanted to check in — we have not spoken in a while. Where does this sit for you now?`);
    say('customer', `Honestly, it has gone quiet. The problem has not gone away, ${pain}, but nothing is forcing us to act.`);
    say('agent', 'What changed since we last spoke?');
    say('customer', 'Two people left and priorities moved. There is no budget line for it this half.');
    say('agent', `Understood. If I check back when planning starts, is that useful, or should I close this off?`);
    say('customer', `Check back. Planning starts in about ${weeks} weeks. If ${decisionMaker} makes it a priority it comes back on the table.`);
    say('agent', 'I will do that, and I will send one thing in the meantime — a short piece on how teams your size measured the admin time saved.');
    say('customer', 'That is fine. Nothing more than that for now.');
  }

  say('agent', 'Last thing — anything I have not asked that I should have?');
  say('customer', 'No, I think you have it. Thanks for being efficient with the time.');
  say('agent', `Thanks ${contact}. Summary and next steps will be with you shortly.`);

  // Stretch or trim the dialogue to roughly match the real call duration.
  const perTurn = Math.max(4, Math.round((targetSeconds || turns.length * 8) / turns.length));
  let clock = 0;
  const segments = turns.map((turn, index) => {
    const words = turn.text.split(/\s+/).length;
    const duration = Math.max(2, Math.min(perTurn * 2, Math.round(words / 2.6)));
    const segment = {
      index,
      speaker: turn.role === 'agent' ? agentName || 'Agent' : `${contact} (customer)`,
      role: turn.role,
      start: clock,
      end: clock + duration,
      text: turn.text,
    };
    clock += duration + 1;
    return segment;
  });

  return {
    segments,
    facts: { seats, budget, competitor, pain, pain2, requirement, requirement2, decisionMaker, weeks, product, scenario },
    durationSeconds: clock,
  };
}

// ----------------------------------------------------------------- API ------
export async function transcribe({ call, lead, deal, agentName, recording }) {
  if (config.ai.stt.url) return externalTranscribe({ call, recording });

  const rand = rng(call.id);
  const scenario = scenarioForStage(deal?.stage, rand);
  const { segments, facts, durationSeconds } = buildDialogue({
    scenario: SCENARIOS[scenario] ? scenario : 'discovery',
    lead,
    deal,
    agentName,
    rand,
    targetSeconds: call.talk_seconds || call.duration_seconds,
  });

  const speakers = [...new Set(segments.map((s) => s.speaker))].map((name, index) => ({
    id: `spk_${index}`,
    label: name,
    role: segments.find((s) => s.speaker === name)?.role || 'unknown',
  }));

  return {
    engine: 'local',
    language: 'en',
    confidence: 0.93,
    durationSeconds,
    segments,
    speakers,
    fullText: segments.map((s) => `${s.role === 'agent' ? 'Agent' : 'Customer'}: ${s.text}`).join('\n'),
    facts,
    synthetic: true,
  };
}

/** Map an external STT response onto our transcript shape. */
async function externalTranscribe({ call, recording }) {
  const url = config.ai.stt.url;
  const apiKey = config.ai.stt.apiKey;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': recording?.contentType || 'audio/wav',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    // Without a deadline a silent provider holds a queue slot indefinitely.
    signal: AbortSignal.timeout(config.ai.stt.timeoutMs),
    body: recording?.buffer,
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`Transcription failed: HTTP ${response.status}`);
  const payload = await response.json();

  const rawSegments = payload.segments || payload.utterances || [];
  const segments = rawSegments.map((s, index) => ({
    index,
    speaker: s.speaker || s.speaker_label || `Speaker ${index % 2}`,
    // Diarisation labels differ per vendor; channel 0 is conventionally the agent.
    role: (s.channel ?? s.speaker) === 0 || /agent|rep/i.test(String(s.speaker || '')) ? 'agent' : 'customer',
    start: Math.round(s.start ?? s.start_time ?? 0),
    end: Math.round(s.end ?? s.end_time ?? 0),
    text: s.text || s.transcript || '',
  }));

  logger.info('external transcription complete', { callId: call.id, segments: segments.length });
  return {
    engine: payload.model || 'external',
    language: payload.language || 'en',
    confidence: payload.confidence ?? null,
    durationSeconds: Math.round(payload.duration || call.duration_seconds || 0),
    segments,
    speakers: [...new Set(segments.map((s) => s.speaker))].map((label, i) => ({ id: `spk_${i}`, label })),
    fullText: payload.text || segments.map((s) => s.text).join('\n'),
    synthetic: false,
  };
}

/** PII redaction applied before a transcript is stored. */
export function redact(text) {
  const redactions = [];
  let output = String(text || '');
  const patterns = [
    { type: 'card', re: /\b(?:\d[ -]*?){13,16}\b/g },
    { type: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
    { type: 'iban', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,26}\b/g },
  ];
  for (const { type, re } of patterns) {
    output = output.replace(re, (match) => {
      redactions.push({ type, length: match.length });
      return `[redacted:${type}]`;
    });
  }
  return { text: output, redactions };
}

export default { transcribe, redact };
