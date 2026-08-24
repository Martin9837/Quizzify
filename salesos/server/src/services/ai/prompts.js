import { STAGE_KEYS, LEAD_TEMPERATURES, OBJECTION_CATEGORIES, COACHING_DIMENSIONS } from '../../lib/constants.js';

/**
 * Prompt library. Kept in one place so prompt changes are reviewable and
 * versionable rather than scattered through call handling code.
 */

export const PROMPT_VERSION = '2026-08-01';

export const ANALYSIS_SYSTEM = `You are the conversation intelligence engine inside a sales CRM.
You read one sales call transcript and return structured sales intelligence.

Rules:
- Ground every field in the transcript. If something was not discussed, omit it or use null. Never invent numbers, dates, names or commitments.
- Quote the transcript verbatim in "evidence" fields, trimmed to the relevant sentence.
- Money values: return a plain number in the currency discussed, no symbols or separators.
- Dates: resolve relative references ("next Tuesday", "end of the quarter") against the call date supplied and return ISO-8601 (YYYY-MM-DD).
- Objection categories must be one of: ${OBJECTION_CATEGORIES.join(', ')}.
- Deal stage must be one of: ${STAGE_KEYS.join(', ')}.
- Lead temperature must be one of: ${LEAD_TEMPERATURES.join(', ')}.
- Confidence is your own calibrated probability that the value is correct (0-1). Use <0.6 when the transcript is ambiguous.
- Coaching scores are 0-100 across these dimensions: ${COACHING_DIMENSIONS.map((d) => d.key).join(', ')}.
- Be concise. Summaries are read between calls, not studied.`;

export const ANALYSIS_TOOL = {
  name: 'record_call_analysis',
  description: 'Record the structured analysis of a sales call transcript.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '2-4 sentence summary of what happened and what it means for the deal.' },
      key_points: { type: 'array', items: { type: 'string' }, description: 'The handful of facts a colleague would need to pick this deal up.' },
      questions: {
        type: 'array',
        description: 'Questions the customer asked.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            answered: { type: 'boolean' },
            topic: { type: 'string' },
          },
          required: ['question'],
        },
      },
      objections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: OBJECTION_CATEGORIES },
            text: { type: 'string' },
            severity: { type: 'string', enum: ['low', 'medium', 'high'] },
            handled: { type: 'boolean' },
            evidence: { type: 'string' },
          },
          required: ['category', 'text'],
        },
      },
      buying_signals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            signal: { type: 'string' },
            strength: { type: 'string', enum: ['weak', 'moderate', 'strong'] },
            evidence: { type: 'string' },
          },
          required: ['signal'],
        },
      },
      risks: { type: 'array', items: { type: 'string' } },
      action_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            owner: { type: 'string', enum: ['agent', 'customer', 'both'] },
            due_date: { type: 'string', description: 'ISO date or null' },
            type: { type: 'string', enum: ['call', 'email', 'follow_up', 'demo', 'proposal', 'research', 'meeting'] },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
          },
          required: ['text'],
        },
      },
      commitments: {
        type: 'array',
        description: 'Explicit promises made on the call, by either side.',
        items: {
          type: 'object',
          properties: {
            party: { type: 'string', enum: ['agent', 'customer'] },
            text: { type: 'string' },
            due_date: { type: 'string' },
            evidence: { type: 'string' },
          },
          required: ['party', 'text'],
        },
      },
      next_steps: { type: 'array', items: { type: 'string' } },
      topics: { type: 'array', items: { type: 'string' } },
      competitors: { type: 'array', items: { type: 'string' } },
      sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'mixed'] },
      sentiment_score: { type: 'number', description: '-1 (hostile) to 1 (enthusiastic)' },
      extraction: {
        type: 'object',
        description: 'CRM fields detected in the conversation. Omit anything not discussed.',
        properties: {
          customer_interest: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
          product_discussed: { type: 'string' },
          budget: { type: 'number' },
          budget_evidence: { type: 'string' },
          timeline: { type: 'string' },
          decision_maker: { type: 'string' },
          decision_process: { type: 'string' },
          pain_points: { type: 'array', items: { type: 'string' } },
          requirements: { type: 'array', items: { type: 'string' } },
          follow_up_date: { type: 'string' },
          deal_stage: { type: 'string', enum: STAGE_KEYS },
          expected_value: { type: 'number' },
          lead_temperature: { type: 'string', enum: LEAD_TEMPERATURES },
          next_action: { type: 'string' },
          job_title: { type: 'string' },
          company_size: { type: 'string' },
          lost_reason: { type: 'string' },
        },
      },
      field_confidence: {
        type: 'object',
        description: 'Map of extraction field name to your confidence (0-1).',
        additionalProperties: { type: 'number' },
      },
      scorecard: {
        type: 'object',
        description: 'Coaching scores 0-100 per dimension.',
        properties: Object.fromEntries(COACHING_DIMENSIONS.map((d) => [d.key, { type: 'number' }])),
      },
      coaching: {
        type: 'object',
        properties: {
          strengths: { type: 'array', items: { type: 'string' } },
          improvements: { type: 'array', items: { type: 'string' } },
          recommendation: { type: 'string' },
          missed_opportunities: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    required: ['summary', 'sentiment'],
  },
};

export function analysisUserPrompt({ transcript, lead, deal, callDate, agentName, customFields }) {
  const context = [
    `Call date: ${callDate}`,
    `Sales agent: ${agentName || 'Unknown'}`,
    lead ? `Contact: ${lead.first_name} ${lead.last_name || ''} (${lead.job_title || 'unknown title'}) at ${lead.company_name || 'unknown company'}` : null,
    lead ? `Known lead status: ${lead.status} / temperature ${lead.temperature} / source ${lead.source || 'unknown'}` : null,
    deal ? `Open deal: "${deal.name}" at stage ${deal.stage}, value ${deal.value || 0} ${deal.currency || 'USD'}, probability ${deal.probability}%` : 'No open deal on record.',
    deal?.competitors ? `Known competitors: ${deal.competitors}` : null,
    customFields?.length
      ? `Organisation-specific fields to extract when discussed: ${customFields.map((f) => `${f.key} (${f.label}${f.ai_hint ? ` - ${f.ai_hint}` : ''})`).join('; ')}`
      : null,
  ].filter(Boolean).join('\n');

  return `${context}

Transcript:
"""
${transcript}
"""

Analyse this call and call the record_call_analysis tool exactly once.`;
}

export const EMAIL_SYSTEM = `You write follow-up emails for sales agents.

Rules:
- Write as the agent, in first person, ready to send after a quick read.
- Reference specifics from the call. Generic filler is worse than a short email.
- Never invent pricing, contractual terms, dates, or commitments that are not in the context.
- Keep it under 180 words unless the template requires detail. Short paragraphs, no walls of text.
- One clear ask, matching the agreed next step.
- No exclamation marks, no "I hope this email finds you well", no marketing language.
- Plain text. Use "\\n\\n" between paragraphs. Sign off with the agent's name only.`;

export const EMAIL_TOOL = {
  name: 'draft_email',
  description: 'Return a ready-to-send follow-up email.',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      body: { type: 'string' },
      talking_points: { type: 'array', items: { type: 'string' }, description: 'Why this draft says what it says.' },
      suggested_send_time: { type: 'string' },
    },
    required: ['subject', 'body'],
  },
};

export function emailUserPrompt({ template, intent, lead, deal, analysis, agent, instructions, transcriptExcerpt, tone }) {
  return [
    `Email type: ${template} - ${intent}`,
    tone ? `Tone: ${tone}` : null,
    `Agent: ${agent?.name || 'the agent'}${agent?.title ? `, ${agent.title}` : ''}`,
    lead ? `Recipient: ${lead.first_name} ${lead.last_name || ''} (${lead.job_title || ''}) at ${lead.company_name || ''}` : null,
    deal ? `Deal: ${deal.name}, stage ${deal.stage}, value ${deal.value || 0} ${deal.currency || 'USD'}` : null,
    analysis?.summary ? `Last call summary: ${analysis.summary}` : null,
    analysis?.objections?.length ? `Objections raised: ${analysis.objections.map((o) => `${o.category}: ${o.text}`).join(' | ')}` : null,
    analysis?.next_steps?.length ? `Agreed next steps: ${analysis.next_steps.join('; ')}` : null,
    analysis?.commitments?.length ? `Commitments: ${analysis.commitments.map((c) => `${c.party}: ${c.text}`).join(' | ')}` : null,
    transcriptExcerpt ? `Relevant transcript excerpt:\n"""\n${transcriptExcerpt}\n"""` : null,
    instructions ? `Agent instructions: ${instructions}` : null,
    'Call the draft_email tool exactly once.',
  ].filter(Boolean).join('\n');
}

export const ASSISTANT_SYSTEM = `You are the AI sales assistant inside a CRM, talking to one sales user.

You answer questions about their pipeline using the data supplied to you in the context block. That context has already been filtered to exactly the records this user is permitted to see -- never speculate about records outside it, and never claim access you do not have.

Rules:
- Lead with the answer. Then the two or three facts that support it.
- Use the record names and numbers from the context. Never invent a lead, deal, amount or date.
- When the context is empty or insufficient, say so plainly and name what would answer the question.
- Prefer short markdown: a sentence, then a compact list. No preamble, no restating the question.
- When you recommend an action, make it specific enough to act on immediately (who to call, what to send, by when).`;

export function assistantUserPrompt({ question, context, user }) {
  return `User: ${user.name} (${user.role})
Question: ${question}

Context (authorised records only):
"""
${context}
"""`;
}

export const TRANSCRIPT_DIARISATION_NOTE = `Speaker labels: "agent" is the sales representative, "customer" is the prospect. Where a third participant appears, label them "participant_N".`;

export default {
  PROMPT_VERSION,
  ANALYSIS_SYSTEM,
  ANALYSIS_TOOL,
  analysisUserPrompt,
  EMAIL_SYSTEM,
  EMAIL_TOOL,
  emailUserPrompt,
  ASSISTANT_SYSTEM,
  assistantUserPrompt,
};
