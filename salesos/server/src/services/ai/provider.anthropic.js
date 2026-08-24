import config from '../../config.js';
import logger from '../../lib/logger.js';
import { upstream } from '../../lib/errors.js';

/**
 * Anthropic Messages API client.
 *
 * Uses `fetch` directly rather than the SDK to keep the dependency surface at
 * zero. Structured output is obtained with tool use plus `tool_choice`, which
 * is far more reliable than asking for JSON in prose.
 */

const API_VERSION = '2023-06-01';

function requireKey() {
  const key = config.ai.anthropic.apiKey;
  if (!key) throw upstream('Anthropic API key is not configured');
  return key;
}

export const isConfigured = () => Boolean(config.ai.anthropic.apiKey);

async function callMessages({ system, messages, tools, toolChoice, maxTokens, temperature, model }) {
  const body = {
    model: model || config.ai.anthropic.model,
    max_tokens: maxTokens || config.ai.anthropic.maxTokens,
    system,
    messages,
  };
  if (tools?.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;
  if (temperature !== undefined) body.temperature = temperature;

  const started = Date.now();
  let response;
  try {
    response = await fetch(`${config.ai.anthropic.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': requireKey(),
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.ai.anthropic.timeoutMs),
    });
  } catch (error) {
    throw upstream(`Anthropic request failed: ${error.message}`);
  }

  const latencyMs = Date.now() - started;
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = payload?.error?.message || `HTTP ${response.status}`;
    logger.warn('anthropic error', { status: response.status, detail, latencyMs });
    // 429/5xx are transient: surface as upstream so the queue retries.
    throw upstream(`Anthropic error: ${detail}`, { status: response.status, retryable: response.status === 429 || response.status >= 500 });
  }

  return {
    content: payload.content || [],
    stopReason: payload.stop_reason,
    model: payload.model,
    usage: {
      inputTokens: payload.usage?.input_tokens || 0,
      outputTokens: payload.usage?.output_tokens || 0,
    },
    latencyMs,
  };
}

/** Run a single tool-use turn and return the tool input as structured data. */
export async function structured({ system, prompt, tool, maxTokens, temperature = 0, model }) {
  const result = await callMessages({
    system,
    messages: [{ role: 'user', content: prompt }],
    tools: [tool],
    toolChoice: { type: 'tool', name: tool.name },
    maxTokens,
    temperature,
    model,
  });
  const block = result.content.find((c) => c.type === 'tool_use' && c.name === tool.name);
  if (!block) throw upstream('Anthropic returned no structured output');
  return { data: block.input, usage: result.usage, model: result.model, latencyMs: result.latencyMs };
}

/** Plain text completion (assistant answers, summaries). */
export async function text({ system, prompt, messages, maxTokens, temperature = 0.2, model }) {
  const result = await callMessages({
    system,
    messages: messages || [{ role: 'user', content: prompt }],
    maxTokens,
    temperature,
    model,
  });
  const answer = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  return { text: answer, usage: result.usage, model: result.model, latencyMs: result.latencyMs };
}

/**
 * Tool-use loop. `toolHandlers` maps tool name to an async function; the model
 * may call several before answering. This is how the assistant queries CRM data
 * without ever seeing records the user is not permitted to read: the handlers
 * apply the same scope filters as the REST API.
 */
export async function toolLoop({ system, messages, tools, toolHandlers, maxTurns = 5, maxTokens, model }) {
  const conversation = [...messages];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const trace = [];

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const result = await callMessages({ system, messages: conversation, tools, maxTokens, temperature: 0, model });
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;

    const toolUses = result.content.filter((c) => c.type === 'tool_use');
    if (!toolUses.length || result.stopReason !== 'tool_use') {
      const answer = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      return { text: answer, usage, trace, model: result.model };
    }

    conversation.push({ role: 'assistant', content: result.content });
    const toolResults = [];
    for (const use of toolUses) {
      const handler = toolHandlers[use.name];
      let output;
      try {
        output = handler ? await handler(use.input || {}) : { error: `Unknown tool ${use.name}` };
      } catch (error) {
        output = { error: error.message };
      }
      trace.push({ tool: use.name, input: use.input, resultSize: JSON.stringify(output || {}).length });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(output ?? null).slice(0, 20000),
      });
    }
    conversation.push({ role: 'user', content: toolResults });
  }

  return { text: 'I could not complete that lookup within the allowed number of steps.', usage, trace, model: config.ai.anthropic.model };
}

export default { isConfigured, structured, text, toolLoop };
