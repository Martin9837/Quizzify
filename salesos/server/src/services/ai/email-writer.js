import { EMAIL_TEMPLATES } from '../../lib/constants.js';

/**
 * Deterministic follow-up email writer.
 *
 * Used when no model is configured. It is template-driven but not generic: every
 * paragraph is assembled from what actually happened on the call -- the
 * objection raised, the commitment made, the date agreed -- so the draft is
 * worth editing rather than worth deleting.
 */

const firstName = (lead) => lead?.first_name || 'there';
const companyOf = (lead) => lead?.company_name || 'your team';

function objectionParagraph(analysis) {
  const objection = (analysis?.objections || [])[0];
  if (!objection) return null;
  const responses = {
    pricing: 'On price: I have set out the two options we discussed so you can compare them side by side, including the phased approach that keeps year one inside your budget.',
    budget: 'On budget: the scoped-down option below fits the figure you mentioned, and the expansion is priced now so it will not move on you later.',
    timing: 'On timing: nothing here needs to start before you are ready. I have noted your timeline and will work back from it.',
    authority: 'I have kept this short enough to forward to the approver, with the numbers and the commercial terms in one place.',
    competitor: 'I have included a direct comparison on the points you said matter most, so your team does not have to assemble it.',
    features: 'On the gaps you raised: below is exactly what is supported today and what is on the roadmap, with dates rather than adjectives.',
    integration: 'On the integration: the sync you asked about is supported, and I have included the detail your technical team will want.',
    security: 'I have attached the security and compliance pack, including the items your review process asked about.',
    contract_terms: 'On the contract: the changes we discussed are reflected in the revised paper, marked so your legal team can see exactly what moved.',
    status_quo: 'I appreciate there is no forcing event right now. I have kept this to the one thing worth revisiting when priorities shift.',
    trust: 'I have included two references from teams of a similar size who went through the same evaluation.',
    support: 'On support and onboarding: here is what the first thirty days looks like, and who owns it on our side.',
  };
  return responses[objection.category] || `On the point you raised about ${String(objection.category).replace('_', ' ')}: I have addressed it below.`;
}

function nextStepParagraph(analysis, template) {
  const nextStep = (analysis?.next_steps || [])[0];
  const commitment = (analysis?.commitments || []).find((c) => c.party === 'agent');
  if (template === 'meeting_confirmation') {
    return 'I have sent a calendar invitation for the time we agreed. If the slot no longer works, reply with two alternatives and I will move it.';
  }
  if (commitment) return `As promised: ${commitment.text.replace(/^(I will|We will|I'll|We'll)\s*/i, '').replace(/\.$/, '')}.`;
  if (nextStep) return `Next step from my side: ${nextStep.replace(/^(agent|customer):\s*/i, '').replace(/\.$/, '')}.`;
  return 'Next step: let me know if the below looks right and I will move it forward.';
}

const OPENINGS = {
  thank_you: (lead) => `Thanks for the time today, ${firstName(lead)}.`,
  follow_up: (lead) => `Following up on our conversation, ${firstName(lead)}.`,
  proposal_follow_up: (lead) => `${firstName(lead)} - checking in on the proposal.`,
  meeting_confirmation: (lead) => `${firstName(lead)} - confirming our session.`,
  product_information: (lead) => `${firstName(lead)} - the detail you asked for.`,
  re_engagement: (lead) => `${firstName(lead)} - worth a fresh look?`,
  objection_response: (lead) => `${firstName(lead)} - on the point you raised.`,
  custom: (lead) => `${firstName(lead)},`,
};

const SUBJECTS = {
  thank_you: (lead, deal) => `Thanks for your time${deal?.product ? ` - ${deal.product}` : ''}`,
  follow_up: (lead, deal) => `Following up${deal?.name ? ` on ${deal.name}` : ` - ${companyOf(lead)}`}`,
  proposal_follow_up: (lead, deal) => `Proposal${deal?.name ? ` - ${deal.name}` : ''}: next steps`,
  meeting_confirmation: () => 'Confirmed: our session',
  product_information: (lead, deal) => `${deal?.product || 'Platform'} detail you asked for`,
  re_engagement: (lead) => `Still worth solving for ${companyOf(lead)}?`,
  objection_response: (lead, deal, analysis) => `On ${String((analysis?.objections || [])[0]?.category || 'your question').replace('_', ' ')}`,
  custom: (lead) => `Following up - ${companyOf(lead)}`,
};

export function writeEmail({ template = 'follow_up', lead, deal, analysis, agent, instructions }) {
  const definition = EMAIL_TEMPLATES.find((t) => t.key === template) || EMAIL_TEMPLATES[1];
  const paragraphs = [];

  paragraphs.push((OPENINGS[template] || OPENINGS.follow_up)(lead));

  // Recap: quote the customer's own framing back to them where we have it.
  const keyPoint = (analysis?.key_points || [])[0];
  const pain = (analysis?.extraction?.pain_points || [])[0];
  if (analysis?.summary) {
    const recap = pain
      ? `To recap what you described: ${String(pain).replace(/^(agent|customer):\s*/i, '').replace(/\.$/, '')}.`
      : keyPoint
        ? `To recap: ${keyPoint}.`
        : null;
    if (recap) paragraphs.push(recap);
  }

  const objection = objectionParagraph(analysis);
  if (objection && ['objection_response', 'proposal_follow_up', 'follow_up', 'thank_you'].includes(template)) {
    paragraphs.push(objection);
  }

  if (template === 'product_information') {
    const requirements = analysis?.extraction?.requirements || [];
    paragraphs.push(requirements.length
      ? `Specifically on what you need:\n- ${requirements.slice(0, 4).join('\n- ')}`
      : 'Here is the detail on the areas you asked about, with the specifics rather than the overview.');
  }

  if (template === 're_engagement') {
    paragraphs.push(`When we last spoke the blocker was ${(analysis?.objections || [])[0]?.category?.replace('_', ' ') || 'timing'}. If that has changed, a fifteen-minute call is probably enough to work out whether this is worth restarting.`);
  }

  if (template === 'proposal_follow_up' && (deal?.value || analysis?.extraction?.expected_value)) {
    const value = deal?.value || analysis.extraction.expected_value;
    paragraphs.push(`The proposal is for ${Number(value).toLocaleString('en-US')} ${deal?.currency || 'USD'}${deal?.timeline || analysis?.extraction?.timeline ? `, working to the ${deal?.timeline || analysis.extraction.timeline} timeline we discussed` : ''}.`);
  }

  paragraphs.push(nextStepParagraph(analysis, template));

  const followUp = analysis?.extraction?.follow_up_date;
  if (followUp && template !== 'meeting_confirmation') {
    paragraphs.push(`I will check back on ${new Date(followUp).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} unless you get to it first.`);
  }

  if (instructions) paragraphs.push(String(instructions).trim());

  paragraphs.push(`${agent?.name || 'Best'}${agent?.title ? `\n${agent.title}` : ''}`);

  const subject = (SUBJECTS[template] || SUBJECTS.follow_up)(lead, deal, analysis);

  return {
    subject,
    body: paragraphs.filter(Boolean).join('\n\n'),
    talking_points: [
      definition.intent,
      analysis?.objections?.length ? `Addresses the ${analysis.objections[0].category.replace('_', ' ')} objection raised on the call` : null,
      analysis?.commitments?.some((c) => c.party === 'agent') ? 'Restates the commitment you made so it is on record' : null,
      followUp ? `Sets an explicit follow-up date (${String(followUp).slice(0, 10)})` : null,
    ].filter(Boolean),
    engine: 'local-template',
  };
}

export default { writeEmail };
