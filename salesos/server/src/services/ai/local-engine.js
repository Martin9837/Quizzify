import { OBJECTION_CATEGORIES, COACHING_DIMENSIONS, STAGE_KEYS } from '../../lib/constants.js';
import { nextBusinessSlot } from '../../lib/time.js';

/**
 * Deterministic conversation-analysis engine.
 *
 * This is the fallback used when no LLM is configured, and the reference
 * implementation of the analysis contract: the object it returns is exactly the
 * shape `record_call_analysis` produces, so downstream code (extraction,
 * suggestions, coaching, email drafting) is provider-agnostic.
 *
 * The rules are lexical rather than learned -- less nuanced than a model, but
 * transparent, instant, free, and good enough that the product is genuinely
 * usable offline.
 */

// --------------------------------------------------------------- lexicons ---
const OBJECTION_PATTERNS = [
  { category: 'pricing', severity: 'high', re: /\b(too expensive|price is|pricing|cost too much|came in at|quoted us lower|cheaper|discount|expensive)\b/i },
  { category: 'budget', severity: 'high', re: /\b(no budget|budget ceiling|budget line|not in the plan|cannot sign above|allocated|budget set aside)\b/i },
  { category: 'timing', severity: 'medium', re: /\b(timing is|not the right time|awkward|mid-way through|next quarter|next year|later this year|after the rollout)\b/i },
  { category: 'authority', severity: 'medium', re: /\b(need approval|signs it off|sign.?off|not my decision|take it to|has to approve)\b/i },
  { category: 'competitor', severity: 'medium', re: /\b(also looking at|evaluating|we use|already have|demo of|quoted us)\b/i },
  { category: 'features', severity: 'medium', re: /\b(missing|does not (do|support)|gap|we need it to|cannot do|looked flat)\b/i },
  { category: 'integration', severity: 'medium', re: /\b(integrat\w+|sync|api|connect to|two-way)\b/i },
  { category: 'security', severity: 'high', re: /\b(security review|soc ?2|iso ?27001|penetration test|data residency|gdpr|compliance)\b/i },
  { category: 'contract_terms', severity: 'high', re: /\b(redline|auto-?renewal|termination|legal|clause|contract change|paper)\b/i },
  { category: 'status_quo', severity: 'medium', re: /\b(gone quiet|nothing is forcing|no urgency|happy with what we have|priorities moved)\b/i },
  { category: 'trust', severity: 'medium', re: /\b(references|case study|proof|guarantee|reassur\w+)\b/i },
  { category: 'support', severity: 'low', re: /\b(support|onboarding|training|implementation help|success manager)\b/i },
];

const BUYING_SIGNALS = [
  { signal: 'Asked for a proposal', strength: 'strong', re: /\b(send (us|me) a proposal|proposal for|put it in writing|revised proposal)\b/i },
  { signal: 'Named a decision timeline', strength: 'strong', re: /\b(sign(ed)? (this|next) week|before the quarter ends|close inside|be live within|within \d+ weeks)\b/i },
  { signal: 'Shared budget figure', strength: 'strong', re: /\b(\d[\d,.]*\s*(dollars|usd|k\b)|budget of|allocated)\b/i },
  { signal: 'Named the decision maker', strength: 'moderate', re: /\b(vp of sales|cro|cfo|coo|signs it off|has approved)\b/i },
  { signal: 'Requested next meeting', strength: 'strong', re: /\b(get it in the diary|working session|book (a|the) (call|meeting)|next week)\b/i },
  { signal: 'Confirmed the pain is costing them', strength: 'moderate', re: /\b(it is real|loses? (maybe )?\w+ minutes|costs? us|should be at)\b/i },
  { signal: 'Involved additional stakeholders', strength: 'moderate', re: /\b(brought the team|was in the demo|our legal|the team came out)\b/i },
  { signal: 'Asked about implementation', strength: 'moderate', re: /\b(onboarding|go.?live|implementation|rollout plan|how long (does|would) it take)\b/i },
  { signal: 'Negotiating terms rather than value', strength: 'strong', re: /\b(redline|termination|auto-?renewal|annual prepay|phased)\b/i },
];

const RISK_PATTERNS = [
  { risk: 'Competitor actively quoted', re: /\bquoted us lower|cheaper|also looking at\b/i },
  { risk: 'No budget in the current period', re: /\bno budget line|not in the plan|budget ceiling\b/i },
  { risk: 'Champion cannot sign alone', re: /\bsigns it off|need approval|not my decision\b/i },
  { risk: 'Deal has stalled with no forcing event', re: /\bgone quiet|nothing is forcing|priorities moved\b/i },
  { risk: 'Blocking security or legal requirement', re: /\bsecurity review|non-negotiable|has to be in the contract|legal asked\b/i },
  { risk: 'Champion turnover on the account', re: /\btwo people left|new (owner|contact)|has left\b/i },
];

const POSITIVE = /\b(great|good|works|makes sense|positive|happy|appreciated|loud and clear|that is fine|yes|agreed|useful|in good shape|ahead)\b/gi;
const NEGATIVE = /\b(problem|expensive|not|no|cannot|concern|issue|awkward|quiet|gap|missing|blocked|difficult|worse|frankly)\b/gi;

const COMPETITOR_NAMES = ['Salesloft', 'Outreach', 'HubSpot', 'Gong', 'Chorus', 'Zoho', 'Pipedrive', 'Salesforce', 'Zoom', 'Dialpad', 'Aircall'];

// ---------------------------------------------------------------- helpers ---
const sentencesOf = (text) => String(text || '').split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 3);

function parseMoney(text) {
  const patterns = [
    /\b(\d{1,3}(?:,\d{3})+)(?:\s*(?:dollars|usd|\$))?/i,
    /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?)/,
    /\b(\d{2,3})\s?k\b/i,
    /\b(\d{4,7})\s*(?:dollars|usd)\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const raw = m[1].replace(/,/g, '');
    const value = /k$/i.test(m[0]) ? Number(raw) * 1000 : Number(raw);
    if (Number.isFinite(value) && value >= 1000) return value;
  }
  return null;
}

function parseTimeline(text) {
  const weeks = text.match(/\bwithin (\d+) weeks?\b|\b(\d+) weeks?\b/i);
  if (weeks) {
    const n = Number(weeks[1] || weeks[2]);
    if (n > 0 && n < 60) return { label: `${n} weeks`, days: n * 7 };
  }
  if (/\bthis quarter|before the quarter ends\b/i.test(text)) return { label: 'this quarter', days: 45 };
  if (/\bnext quarter\b/i.test(text)) return { label: 'next quarter', days: 120 };
  if (/\bthis week\b/i.test(text)) return { label: 'this week', days: 5 };
  if (/\bnext week\b/i.test(text)) return { label: 'next week', days: 7 };
  if (/\bnext month\b/i.test(text)) return { label: 'next month', days: 30 };
  if (/\bnext fiscal year|next year\b/i.test(text)) return { label: 'next fiscal year', days: 240 };
  return null;
}

function parseDecisionMaker(text) {
  const patterns = [
    /\b(?:our|the)\s+(VP of Sales|CRO|CFO|COO|CEO|CTO|Head of Sales|VP of Revenue)(?:,\s*([A-Z][a-z]+ [A-Z][a-z]+))?/,
    /\b([A-Z][a-z]+ [A-Z][a-z]+)\s+(?:signs it off|has approved|will approve|needs to approve)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return [m[2], m[1]].filter(Boolean).join(', ');
  }
  return null;
}

function parseSeats(text) {
  const m = text.match(/\b(\d{1,4})\s*(?:reps|seats|users|licences|licenses)\b/i);
  return m ? Number(m[1]) : null;
}

function extractList(sentences, re, limit = 4) {
  const found = [];
  for (const sentence of sentences) {
    if (!re.test(sentence)) continue;
    const cleaned = sentence.replace(/^(agent|customer):\s*/i, '').trim();
    if (cleaned.length > 15 && !found.includes(cleaned)) found.push(cleaned.slice(0, 220));
    if (found.length >= limit) break;
  }
  return found;
}

// ------------------------------------------------------------------ main ----
export function analyseTranscript({ segments, fullText, lead, deal, callDate = new Date().toISOString() }) {
  const text = fullText || segments.map((s) => s.text).join('\n');
  const customerText = segments.filter((s) => s.role === 'customer').map((s) => s.text).join(' ');
  const agentText = segments.filter((s) => s.role === 'agent').map((s) => s.text).join(' ');
  const customerSentences = sentencesOf(customerText);
  const allSentences = sentencesOf(text);

  // ---- talk ratio -----------------------------------------------------------
  const agentWords = agentText.split(/\s+/).filter(Boolean).length;
  const customerWords = customerText.split(/\s+/).filter(Boolean).length;
  const totalWords = agentWords + customerWords || 1;
  const talkRatio = Math.round((agentWords / totalWords) * 100) / 100;

  // ---- objections -----------------------------------------------------------
  // A matching sentence is only useful if it carries the objection. "The price
  // is." matches the pricing pattern but tells a reader nothing, so prefer the
  // most informative matching sentence and fall back to stitching in the next
  // one when the match on its own is too thin.
  const objectionSentence = (pattern) => {
    const matches = customerSentences
      .map((sentence, index) => ({ sentence: sentence.trim(), index }))
      .filter(({ sentence }) => pattern.re.test(sentence));
    if (!matches.length) return null;
    const substantial = matches.find(({ sentence }) => sentence.split(/\s+/).length >= 6);
    if (substantial) return substantial.sentence;
    const thin = matches[0];
    const next = customerSentences[thin.index + 1]?.trim();
    return next ? `${thin.sentence} ${next}` : thin.sentence;
  };

  const objections = [];
  for (const pattern of OBJECTION_PATTERNS) {
    const sentence = objectionSentence(pattern);
    if (!sentence) continue;
    // "Handled" heuristic: the agent responded substantively after the objection.
    const objectionIndex = allSentences.findIndex((s) => s === sentence);
    const agentFollowUp = allSentences.slice(objectionIndex + 1, objectionIndex + 4).join(' ');
    objections.push({
      category: pattern.category,
      text: sentence.trim().slice(0, 240),
      severity: pattern.severity,
      handled: /\b(understood|two options|I will|we can|doable|supported|let us|I can get)\b/i.test(agentFollowUp),
      evidence: sentence.trim().slice(0, 240),
    });
    if (objections.length >= 5) break;
  }

  // ---- buying signals -----------------------------------------------------
  const buyingSignals = [];
  for (const signal of BUYING_SIGNALS) {
    if (!signal.re.test(customerText)) continue;
    const matches = customerSentences.filter((sentence) => signal.re.test(sentence));
    const sentence = matches.find((candidate) => candidate.split(/\s+/).length >= 6) || matches[0];
    buyingSignals.push({
      signal: signal.signal,
      strength: signal.strength,
      evidence: (sentence || '').trim().slice(0, 220),
    });
  }

  // ---- risks --------------------------------------------------------------
  const risks = RISK_PATTERNS.filter((r) => r.re.test(text)).map((r) => r.risk);

  // ---- questions ----------------------------------------------------------
  const questions = customerSentences
    .filter((s) => s.trim().endsWith('?'))
    .slice(0, 6)
    .map((q) => ({
      question: q.trim(),
      answered: true,
      topic: OBJECTION_PATTERNS.find((p) => p.re.test(q))?.category || 'general',
    }));

  // ---- structured extraction ---------------------------------------------
  const budget = parseMoney(customerText);
  const timeline = parseTimeline(text);
  const decisionMaker = parseDecisionMaker(text);
  const seats = parseSeats(text);
  const competitors = COMPETITOR_NAMES.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(text));
  const painPoints = extractList(customerSentences, /\b(problem|issue|lose|loses|costs?|cannot|missed|inconsistent|spend)\b/i, 3);
  const requirements = extractList(allSentences, /\b(we need|has to|non-negotiable|must|required|requirement)\b/i, 4);

  // ---- sentiment ----------------------------------------------------------
  const positiveHits = (customerText.match(POSITIVE) || []).length;
  const negativeHits = (customerText.match(NEGATIVE) || []).length;
  const sentimentScore = Math.max(-1, Math.min(1, (positiveHits - negativeHits) / Math.max(6, positiveHits + negativeHits)));
  const sentiment = sentimentScore > 0.2 ? 'positive'
    : sentimentScore < -0.2 ? 'negative'
      : positiveHits && negativeHits ? 'mixed' : 'neutral';

  // ---- interest & temperature -------------------------------------------
  const strongSignals = buyingSignals.filter((s) => s.strength === 'strong').length;
  const blocking = objections.filter((o) => o.severity === 'high' && !o.handled).length;
  const interestScore = strongSignals * 2 + buyingSignals.length - blocking * 2 + (sentimentScore > 0 ? 1 : -1);
  const customerInterest = interestScore >= 6 ? 'high' : interestScore >= 3 ? 'medium' : interestScore >= 0 ? 'low' : 'none';
  const temperature = customerInterest === 'high' ? 'hot' : customerInterest === 'medium' ? 'warm' : 'cold';

  // ---- stage inference ---------------------------------------------------
  const stage = inferStage({ text, deal, objections, buyingSignals });

  // ---- next steps & action items ----------------------------------------
  // Next steps live in the back half of a call. Searching the whole transcript
  // picks up the opening consent script ("so I can send you a summary"), which
  // is housekeeping rather than an agreed action.
  const closingSentences = allSentences.slice(Math.floor(allSentences.length * 0.45))
    .filter((s) => !/\b(recording|comfortable|hear me|loud and clear)\b/i.test(s))
    // A question is not a commitment -- next steps are what someone said they
    // would do, not what they asked.
    .filter((s) => !s.trim().endsWith('?'));
  const nextStepSentences = extractList(
    closingSentences,
    /\b(I will|we will|send (you|the|across|it)|next step|get it in the diary|introduce you|follow up|check back|put it in writing|have (it|the \w+) with you)\b/i,
    5,
  );
  const followUpDays = timeline?.days && timeline.days <= 14 ? Math.max(1, Math.round(timeline.days / 2)) : 3;
  const followUpDate = nextBusinessSlot(followUpDays, 15, new Date(callDate));

  const actionItems = buildActionItems({ text, nextStepSentences, followUpDate, objections, timeline });
  const commitments = buildCommitments({ segments, followUpDate });

  // ---- coaching ----------------------------------------------------------
  const scorecard = scoreCall({ segments, agentText, customerText, talkRatio, objections, nextStepSentences, questions });
  const coaching = buildCoaching({ scorecard, talkRatio, objections, nextStepSentences, questions, buyingSignals });

  // ---- summary -----------------------------------------------------------
  const summary = buildSummary({
    lead, deal, sentiment, customerInterest, objections, buyingSignals, budget, timeline, decisionMaker, nextStepSentences, stage,
  });

  const keyPoints = [
    budget ? `Budget indicated: ${budget.toLocaleString('en-US')}` : null,
    timeline ? `Timeline: ${timeline.label}` : null,
    decisionMaker ? `Decision maker: ${decisionMaker}` : null,
    seats ? `Team size discussed: ${seats} seats` : null,
    competitors.length ? `Competitors mentioned: ${competitors.join(', ')}` : null,
    objections.length ? `Primary objection: ${objections[0].category.replace('_', ' ')}` : null,
    requirements.length ? `Requirement: ${requirements[0]}` : null,
  ].filter(Boolean).slice(0, 6);

  const extraction = {
    customer_interest: customerInterest,
    product_discussed: deal?.product || null,
    budget: budget || null,
    budget_evidence: budget ? customerSentences.find((s) => parseMoney(s) === budget) || null : null,
    timeline: timeline?.label || null,
    decision_maker: decisionMaker,
    pain_points: painPoints,
    requirements,
    follow_up_date: followUpDate.slice(0, 10),
    deal_stage: stage,
    expected_value: budget || null,
    lead_temperature: temperature,
    next_action: nextStepSentences[0] || null,
    competitors,
    company_size: seats ? `${seats} sales seats` : null,
    lost_reason: /\bnot going ahead|decided against|going with\b/i.test(customerText) ? 'Chose an alternative' : null,
  };

  // Confidence is derived from how directly the evidence supports each field --
  // an explicit number in the transcript beats an inference every time.
  const fieldConfidence = {
    budget: budget ? 0.88 : 0,
    timeline: timeline ? 0.8 : 0,
    decision_maker: decisionMaker ? 0.82 : 0,
    deal_stage: stage ? (objections.length || buyingSignals.length ? 0.72 : 0.55) : 0,
    lead_temperature: 0.76,
    follow_up_date: 0.7,
    expected_value: budget ? 0.7 : 0,
    pain_points: painPoints.length ? 0.68 : 0,
    requirements: requirements.length ? 0.7 : 0,
    competitors: competitors.length ? 0.85 : 0,
    next_action: nextStepSentences.length ? 0.75 : 0,
    customer_interest: 0.7,
  };

  return {
    summary,
    key_points: keyPoints,
    questions,
    objections,
    buying_signals: buyingSignals,
    risks,
    action_items: actionItems,
    commitments,
    next_steps: nextStepSentences.slice(0, 4),
    topics: [...new Set([...objections.map((o) => o.category), ...(timeline ? ['timeline'] : []), ...(budget ? ['budget'] : [])])],
    competitors,
    sentiment,
    sentiment_score: Math.round(sentimentScore * 100) / 100,
    talk_ratio: talkRatio,
    extraction,
    field_confidence: fieldConfidence,
    scorecard,
    coaching,
    engine: 'local-heuristic',
  };
}

function inferStage({ text, deal, objections, buyingSignals }) {
  const current = deal?.stage;
  const currentIndex = STAGE_KEYS.indexOf(current);
  let inferred = current || 'contacted';

  if (/\bredline|auto-?renewal|termination|contract change|legal asked\b/i.test(text)) inferred = 'negotiation';
  else if (/\b(proposal|revised proposal|quote|put it in writing)\b/i.test(text)) inferred = 'proposal';
  else if (/\b(demo|walk ?through|show you the|screen ?share)\b/i.test(text)) inferred = 'demo';
  else if (/\b(budget|decision|evaluation process|signs it off)\b/i.test(text)) inferred = 'qualified';
  else if (objections.some((o) => o.category === 'status_quo')) inferred = current || 'contacted';

  // Never regress a deal on inference alone -- a stage going backwards is a
  // judgement call for a human, so we only propose forward movement.
  const inferredIndex = STAGE_KEYS.indexOf(inferred);
  if (currentIndex >= 0 && inferredIndex < currentIndex) return current;
  if (buyingSignals.length === 0 && !objections.length) return current || inferred;
  return inferred;
}

function buildActionItems({ text, nextStepSentences, followUpDate, objections, timeline }) {
  const items = [];
  const add = (item) => {
    if (!items.some((i) => i.text === item.text)) items.push(item);
  };

  if (/\b(send|share).{0,30}(proposal|revised proposal|quote)\b/i.test(text)) {
    add({ text: 'Send the proposal', owner: 'agent', type: 'proposal', priority: 'high', due_date: followUpDate.slice(0, 10) });
  }
  if (/\b(security pack|security review|soc ?2|data residency|gdpr)\b/i.test(text)) {
    add({ text: 'Send the security and compliance pack', owner: 'agent', type: 'email', priority: 'high', due_date: followUpDate.slice(0, 10) });
  }
  if (/\b(demo|working session|walk ?through)\b/i.test(text)) {
    add({ text: 'Schedule the working session with the decision maker', owner: 'agent', type: 'meeting', priority: 'high', due_date: followUpDate.slice(0, 10) });
  }
  if (/\b(summary|recap|notes)\b/i.test(text)) {
    add({ text: 'Send call summary and agreed next steps', owner: 'agent', type: 'email', priority: 'medium', due_date: followUpDate.slice(0, 10) });
  }
  for (const objection of objections.filter((o) => !o.handled).slice(0, 2)) {
    add({
      text: `Respond to the ${objection.category.replace('_', ' ')} objection`,
      owner: 'agent',
      type: 'follow_up',
      priority: objection.severity === 'high' ? 'urgent' : 'medium',
      due_date: followUpDate.slice(0, 10),
    });
  }
  if (!items.length) {
    add({
      text: nextStepSentences[0] ? `Follow up: ${nextStepSentences[0].slice(0, 120)}` : 'Follow up on the conversation',
      owner: 'agent',
      type: 'follow_up',
      priority: 'medium',
      due_date: followUpDate.slice(0, 10),
    });
  }
  if (timeline?.days && timeline.days > 30) {
    add({
      text: `Check back when planning starts (${timeline.label})`,
      owner: 'agent',
      type: 'call',
      priority: 'low',
      due_date: nextBusinessSlot(Math.min(timeline.days, 120)).slice(0, 10),
    });
  }
  return items.slice(0, 6);
}

function buildCommitments({ segments, followUpDate }) {
  const commitments = [];
  for (const segment of segments) {
    const promises = sentencesOf(segment.text).filter((s) => /\b(I will|we will|I'll|we'll|I can get|I am going to|do that and)\b/i.test(s));
    for (const promise of promises) {
      commitments.push({
        party: segment.role === 'agent' ? 'agent' : 'customer',
        text: promise.trim().slice(0, 200),
        due_date: followUpDate.slice(0, 10),
        evidence: promise.trim().slice(0, 200),
      });
    }
  }
  return commitments.slice(0, 6);
}

function scoreCall({ segments, agentText, customerText, talkRatio, objections, nextStepSentences, questions }) {
  const agentQuestions = (agentText.match(/\?/g) || []).length;
  const openQuestions = (agentText.match(/\b(what|how|why|tell me|walk me through|help me understand)\b/gi) || []).length;
  const firstAgent = segments.find((s) => s.role === 'agent')?.text || '';

  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

  const scores = {
    // A good opening states purpose and asks permission for the time.
    opening: clamp(45 + (/\bthanks for (making the time|your time)\b/i.test(firstAgent) ? 20 : 0)
      + (/\b(ten minutes|keep this to|before we start)\b/i.test(agentText) ? 20 : 0)
      + (/\brecording\b/i.test(agentText) ? 15 : 0)),
    discovery: clamp(30 + openQuestions * 7 + agentQuestions * 3),
    product_knowledge: clamp(50 + (/\b(supported|configurable|I will confirm|our platform team|standard on)\b/i.test(agentText) ? 25 : 0)
      + (/\b(I do not know|not sure|I think maybe)\b/i.test(agentText) ? -20 : 10)),
    objection_handling: clamp(objections.length === 0 ? 60
      : 35 + (objections.filter((o) => o.handled).length / objections.length) * 55),
    // Talk ratio is the single most predictive coaching metric: 40-50% is ideal.
    listening: clamp(100 - Math.abs(talkRatio - 0.45) * 220),
    engagement: clamp(30 + Math.min(50, customerText.split(/\s+/).length / 6) + questions.length * 5),
    closing: clamp(30 + (/\b(let us aim|shall we|can we|are we still aiming|would that work)\b/i.test(agentText) ? 35 : 0)
      + (/\b(this week|next week|tomorrow|by friday)\b/i.test(agentText) ? 25 : 0)),
    next_step: clamp(nextStepSentences.length ? 55 + nextStepSentences.length * 12 : 25),
  };

  const weighted = COACHING_DIMENSIONS.reduce(
    (acc, dim) => {
      acc.total += (scores[dim.key] || 0) * dim.weight;
      acc.weight += dim.weight;
      return acc;
    },
    { total: 0, weight: 0 },
  );
  scores.overall = Math.round(weighted.total / weighted.weight);
  return scores;
}

function buildCoaching({ scorecard, talkRatio, objections, nextStepSentences, questions, buyingSignals }) {
  const strengths = [];
  const improvements = [];
  const missed = [];

  if (scorecard.discovery >= 70) strengths.push('Strong discovery: open questions kept the customer talking about their own problem.');
  if (scorecard.objection_handling >= 70) strengths.push('Objections were acknowledged and answered with a concrete option rather than deflected.');
  if (scorecard.next_step >= 70) strengths.push('The call ended with a specific, dated next step.');
  if (talkRatio <= 0.5) strengths.push(`Good talk balance (${Math.round(talkRatio * 100)}% agent).`);
  if (scorecard.opening >= 70) strengths.push('Clean opening: purpose, time expectation and recording consent all covered.');

  if (talkRatio > 0.6) improvements.push(`You spoke ${Math.round(talkRatio * 100)}% of the call. Aim for 40-50% -- ask, then stop talking.`);
  if (scorecard.discovery < 55) improvements.push('Only a few open questions. Try "walk me through how that works today" before positioning anything.');
  if (objections.some((o) => !o.handled)) {
    improvements.push(`Unresolved objection: ${objections.filter((o) => !o.handled).map((o) => o.category.replace('_', ' ')).join(', ')}. Address it explicitly on the next contact.`);
  }
  if (!nextStepSentences.length) improvements.push('No next step was confirmed. Never end a call without a date in the diary.');
  if (scorecard.closing < 50) improvements.push('The close was soft. Propose a specific time rather than asking whether to follow up.');

  if (!/\b(budget|price|cost)\b/i.test(JSON.stringify(objections)) && !buyingSignals.some((s) => s.signal.includes('budget'))) {
    missed.push('Budget was never established -- qualify it before investing in a proposal.');
  }
  if (!buyingSignals.some((s) => s.signal.includes('decision maker'))) {
    missed.push('The decision process was not mapped. Ask who else signs off and what their criteria are.');
  }
  if (questions.length > 3 && scorecard.product_knowledge < 60) {
    missed.push('Several customer questions were answered thinly. Follow up in writing with specifics.');
  }

  const recommendation = improvements[0]
    || 'Solid call. Repeat this structure: purpose, open questions, explicit objection handling, dated next step.';

  return { strengths, improvements, missed_opportunities: missed, recommendation };
}

function buildSummary({ lead, deal, sentiment, customerInterest, objections, buyingSignals, budget, timeline, decisionMaker, nextStepSentences, stage }) {
  const who = lead ? `${lead.first_name}${lead.company_name ? ` at ${lead.company_name}` : ''}` : 'The prospect';
  const parts = [];

  parts.push(`${who} showed ${customerInterest} interest and the tone was ${sentiment}.`);
  const facts = [
    budget ? `budget of ${budget.toLocaleString('en-US')}` : null,
    timeline ? `a ${timeline.label} timeline` : null,
    decisionMaker ? `${decisionMaker} as the approver` : null,
  ].filter(Boolean);
  if (facts.length) parts.push(`They confirmed ${facts.join(', ')}.`);
  if (objections.length) {
    const primary = objections[0];
    parts.push(`The main obstacle is ${primary.category.replace('_', ' ')}${primary.handled ? ', which was addressed on the call' : ', which is still open'}.`);
  }
  if (buyingSignals.length) {
    parts.push(`Positive signals: ${buyingSignals.slice(0, 2).map((s) => s.signal.toLowerCase()).join(' and ')}.`);
  }
  if (nextStepSentences.length) {
    parts.push(`Agreed next step: ${nextStepSentences[0].replace(/^(agent|customer):\s*/i, '').slice(0, 140)}`);
  }
  if (deal && stage && stage !== deal.stage) {
    parts.push(`This moves the deal from ${deal.stage.replace('_', ' ')} to ${stage.replace('_', ' ')}.`);
  }
  return parts.join(' ');
}

export default { analyseTranscript };
