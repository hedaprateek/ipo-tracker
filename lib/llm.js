'use strict';

/**
 * The model behind the apply/avoid read, behind one interface.
 *
 * Two providers, picked automatically from whichever key is present:
 *
 *   GEMINI_API_KEY     -> Google Gemini, has a free tier, no npm dependency
 *   ANTHROPIC_API_KEY  -> Claude, needs @anthropic-ai/sdk
 *
 * Set IPO_LLM_PROVIDER=gemini|anthropic to force one when both keys are set.
 * Both return the same thing: an object validated against the JSON schema.
 */

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

/** Marks a failure as worth stopping the whole run for, not just this IPO. */
class FatalLlmError extends Error {}

function pickProvider() {
  const forced = (process.env.IPO_LLM_PROVIDER || '').toLowerCase();
  if (forced === 'gemini') return process.env.GEMINI_API_KEY ? 'gemini' : null;
  if (forced === 'anthropic') return process.env.ANTHROPIC_API_KEY ? 'anthropic' : null;
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

// ------------------------------------------------------------------ gemini

/**
 * Gemini's schema dialect is an OpenAPI subset — it rejects `additionalProperties`
 * and ignores `minItems`. Strip what it will not accept rather than keeping two
 * hand-written copies of the same schema in sync.
 */
function geminiSchema(node) {
  if (Array.isArray(node)) return node.map(geminiSchema);
  if (!node || typeof node !== 'object') return node;

  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'additionalProperties' || k === 'minItems') continue;
    out[k] = geminiSchema(v);
  }
  return out;
}

/** Pull the text out whether or not the convenience field is present. */
function geminiText(body) {
  if (typeof body.output_text === 'string' && body.output_text) return body.output_text;
  for (const step of body.steps || []) {
    for (const block of step.content || []) {
      if (block.type === 'text' && block.text) return block.text;
    }
  }
  return null;
}

async function callGemini({ system, prompt, schema }) {
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: {
      'x-goog-api-key': process.env.GEMINI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      system_instruction: system,
      input: prompt,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: geminiSchema(schema),
      },
    }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    // 401/403 mean the key is wrong; 429 means the free tier is spent. Neither
    // is fixed by trying the next IPO.
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      throw new FatalLlmError(`Gemini ${res.status}: ${detail}`);
    }
    throw new Error(`Gemini ${res.status}: ${detail}`);
  }

  const body = await res.json();
  const text = geminiText(body);
  if (!text) throw new Error('Gemini returned no text content');

  return {
    data: JSON.parse(text),
    model: body.model || GEMINI_MODEL,
    usage: {
      input: body.usage?.input_tokens ?? 0,
      output: body.usage?.output_tokens ?? 0,
    },
  };
}

// --------------------------------------------------------------- anthropic

let anthropicClient = null;

async function callAnthropic({ system, prompt, schema }) {
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    throw new FatalLlmError('@anthropic-ai/sdk is not installed — run: npm install');
  }
  if (!anthropicClient) anthropicClient = new Anthropic();

  let response;
  try {
    response = await anthropicClient.beta.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new FatalLlmError('ANTHROPIC_API_KEY is invalid');
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new FatalLlmError('rate limited by the Anthropic API');
    }
    throw err;
  }

  if (response.stop_reason === 'refusal') {
    throw new Error(`declined (${response.stop_details?.category || 'unspecified'})`);
  }

  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('no text block in response');

  return {
    data: JSON.parse(text),
    model: response.model,
    usage: {
      input: response.usage.input_tokens || 0,
      output: response.usage.output_tokens || 0,
    },
  };
}

// ------------------------------------------------------------------ public

/** Per-1M-token rates, used only to print a rough cost at the end of a run. */
const RATES = {
  'claude-opus-5': { input: 5, output: 25 },
  default: { input: 0, output: 0 },
};

function describeProvider(provider) {
  return provider === 'gemini'
    ? `Gemini (${GEMINI_MODEL}, free tier)`
    : `Claude (${ANTHROPIC_MODEL})`;
}

function estimateCost(provider, usage) {
  if (provider === 'gemini') return 0;
  const rate = RATES[ANTHROPIC_MODEL] || RATES.default;
  return (usage.input * rate.input + usage.output * rate.output) / 1e6;
}

async function complete(provider, args) {
  return provider === 'gemini' ? callGemini(args) : callAnthropic(args);
}

module.exports = {
  pickProvider, complete, describeProvider, estimateCost,
  FatalLlmError, GEMINI_MODEL, ANTHROPIC_MODEL,
};
