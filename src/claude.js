// AI client. Two backends with the same ask() contract:
//  - kiro: shells out to kiro-cli with a web-only agent (see kiro.js)
//  - anthropic: calls the Claude Messages API directly with fetch (no SDK needed)
import { kiroAsk, kiroListModels, hasKiroKey } from './kiro.js';

const API = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const VERSION = '2023-06-01';

export class ClaudeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function headers() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ClaudeError('ANTHROPIC_API_KEY is not set. Add it to .env and restart.', 400);
  return {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': VERSION,
  };
}

/** "kiro" or "anthropic". Explicit AI_PROVIDER wins; otherwise use whichever key is set (Kiro first). */
export function provider() {
  const p = (process.env.AI_PROVIDER || '').toLowerCase();
  if (p === 'kiro' || p === 'anthropic') return p;
  return process.env.KIRO_API_KEY ? 'kiro' : 'anthropic';
}

export function hasKey() {
  return provider() === 'kiro' ? hasKiroKey() : Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function listModels() {
  return provider() === 'kiro' ? kiroListModels() : listAnthropicModels();
}

async function listAnthropicModels() {
  const res = await fetch(`${API}/v1/models?limit=100`, { headers: headers() });
  if (!res.ok) throw new ClaudeError(`Model list failed: ${res.status} ${await res.text()}`, res.status);
  const body = await res.json();
  return (body.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
}

let cachedDefault = null;
export async function resolveModel(preferred) {
  if (preferred) return preferred;
  if (process.env.CLAUDE_MODEL) return process.env.CLAUDE_MODEL;
  if (cachedDefault) return cachedDefault;
  const models = await listAnthropicModels();
  // Newest models are listed first. Sonnet is the cost/quality sweet spot for this workload.
  const pick = models.find((m) => /sonnet/i.test(m.id)) || models.find((m) => /opus/i.test(m.id)) || models[0];
  if (!pick) throw new ClaudeError('No Claude models available for this API key.', 400);
  cachedDefault = pick.id;
  return cachedDefault;
}

/**
 * Run one Claude turn, following pause_turn continuations from server tools.
 * Returns { text, searchedUrls, usage, model }.
 */
export async function ask({ system, prompt, model, webSearch = false, maxSearches = 8, maxTokens = 8000 }) {
  if (provider() === 'kiro') {
    return kiroAsk({ system, prompt, model: model || process.env.KIRO_MODEL || '', webSearch, maxSearches });
  }
  const modelId = await resolveModel(model);
  const tools = webSearch
    ? [{ type: process.env.WEB_SEARCH_TOOL || 'web_search_20250305', name: 'web_search', max_uses: maxSearches }]
    : undefined;

  const messages = [{ role: 'user', content: prompt }];
  const usage = { input_tokens: 0, output_tokens: 0, web_searches: 0 };
  const searchedUrls = new Set();
  let text = '';

  for (let turn = 0; turn < 6; turn++) {
    const res = await fetch(`${API}/v1/messages`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ model: modelId, max_tokens: maxTokens, system, messages, ...(tools && { tools }) }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new ClaudeError(`Claude API error ${res.status}: ${detail.slice(0, 500)}`, res.status);
    }
    const body = await res.json();
    usage.input_tokens += body.usage?.input_tokens || 0;
    usage.output_tokens += body.usage?.output_tokens || 0;
    usage.web_searches += body.usage?.server_tool_use?.web_search_requests || 0;

    for (const block of body.content || []) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) if (r.url) searchedUrls.add(r.url);
      }
      // Citations on text blocks also point at pages Claude actually read.
      for (const c of block.citations || []) if (c.url) searchedUrls.add(c.url);
    }

    if (body.stop_reason === 'pause_turn') {
      // Server-side tool loop paused; send the partial assistant turn back to continue.
      messages.push({ role: 'assistant', content: body.content });
      continue;
    }
    break;
  }

  return { text, searchedUrls: [...searchedUrls], usage, model: modelId };
}

/** Pull the first JSON object/array out of a model response. */
export function extractJson(text) {
  // Prefer the last fenced block: with web search, the final answer comes after any narration.
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]).reverse();
  const candidates = [...fenced, text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.search(/[[{]/);
    if (start === -1) continue;
    const open = c[start];
    const close = open === '[' ? ']' : '}';
    const end = c.lastIndexOf(close);
    if (end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      /* try next candidate */
    }
  }
  throw new Error('The AI did not return valid JSON.');
}
