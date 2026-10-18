'use strict';
/** OpenAI-compatible HTTP client for the LLM checkup (Node global fetch, no deps). */

const THINK_OPEN = '<' + 'think' + '>';
const THINK_CLOSE = '<' + '/' + 'think' + '>';

/** Typed errors — the renderer surfaces `err.message` verbatim. */
class LLMError extends Error {
  constructor(msg) { super(msg); this.name = this.constructor.name; }
}
class LLMAuthError extends LLMError {
  constructor() { super('endpoint requires an API key — enter it in Settings'); }
}
class LLMBadEndpoint extends LLMError {
  constructor(msg) { super(msg || 'endpoint did not respond with a valid API response (check the URL)'); }
}
class LLMTimeout extends LLMError {
  constructor() { super('request timed out'); }
}
class LLMHttpError extends LLMError {
  constructor(status) { super('HTTP ' + status); this.status = status; }
}

function headers(key) {
  const h = { 'Content-Type': 'application/json' };
  if (key) h['Authorization'] = 'Bearer ' + key;
  return h;
}

/** Best-effort context-length extraction from a /models body (LM Studio & friends). */
function pickContextTokens(body) {
  try {
    const entries = Array.isArray(body && body.data) ? body.data : (Array.isArray(body) ? body : []);
    for (const m of entries) {
      const meta = m && m.meta;
      const cands = [
        meta && (meta.context_length ?? meta.contextLength),
        m.context_length, m.contextLength,
        m.max_context_length, m.maxContextLength,
        m.limits && (m.limits.context_length ?? m.limits.contextLength),
      ];
      for (const c of cands) {
        const n = Number(c);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  } catch { /* absent context info is fine */ }
  return null;
}

async function probeModels(endpoint, apiKey) {
  const base = String(endpoint || '').replace(/\/+$/, '');
  if (!base) throw new LLMBadEndpoint('no endpoint configured');
  let res;
  try {
    res = await fetch(base + '/models', { method: 'GET', headers: headers(apiKey) });
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw new LLMTimeout();
    throw new LLMBadEndpoint('could not reach the endpoint (' + (e && e.message) + ')');
  }
  if (res.status === 401 || res.status === 403) throw new LLMAuthError();
  if (!res.ok) throw new LLMHttpError(res.status);
  let body;
  try { body = await res.json(); } catch { throw new LLMBadEndpoint(); }
  const entries = Array.isArray(body && body.data) ? body.data : (Array.isArray(body) ? body : []);
  const models = entries
    .map((m) => (m && typeof m.id === 'string') ? { id: m.id } : null)
    .filter(Boolean);
  return { ok: true, models, contextTokens: pickContextTokens(body) };
}

/** D3 normalization: prefer reasoning_content, else strip think-tags, extract JSON. */
function normalize(content, reasoning, thinkStrip) {
  let text = String(content == null ? '' : content);
  if (reasoning == null && thinkStrip && text.includes(THINK_OPEN)) {
    // Strip an opening tag through its closing tag, and an unclosed tag to end-of-content.
    // Only when something JSON-like (a fence or '{') follows the stripped region.
    let out = '';
    let rest = text;
    for (;;) {
      const open = rest.indexOf(THINK_OPEN);
      if (open === -1) { out += rest; break; }
      out += rest.slice(0, open);
      const afterOpen = rest.slice(open + THINK_OPEN.length);
      const close = afterOpen.indexOf(THINK_CLOSE);
      if (close === -1) {
        // Unclosed tag: the thinking region runs to the first JSON-like token
        // (the answer) — strip the tag + reasoning and keep the answer — but
        // only when something JSON-like (a fence or '{') actually follows;
        // otherwise the tag is legit content (e.g. JSON containing the string).
        const jsonLike = afterOpen.search(/```|\{/);
        if (jsonLike !== -1) {
          rest = afterOpen.slice(jsonLike);
          continue; // answer kept; rescan `rest` for any further think blocks
        }
        out += THINK_OPEN;
        rest = afterOpen;
        break;
      }
      const remainder = afterOpen.slice(close + THINK_CLOSE.length);
      if (/\s*(?:```|\{)/.test(remainder)) {
        rest = remainder; // strip confirmed; keep scanning for more blocks
      } else {
        // Nothing JSON-like follows — treat the think region as legit content.
        out += THINK_OPEN;
        rest = afterOpen;
      }
    }
    text = out;
  }
  return text;
}

/** Extract the first balanced JSON object, tolerating markdown fences. */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  for (const cand of candidates) {
    const start = cand.indexOf('{');
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < cand.length; i++) {
      const ch = cand[i];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(cand.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

async function chat({ base, key, model, messages, contextTokens, signal, temperature, thinking }) {
  const url = String(base || '').replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model,
    messages,
    temperature: typeof temperature === 'number' ? temperature : 0,
    stream: false,
  };
  if (Number.isFinite(contextTokens) && contextTokens > 0) {
    body.max_tokens = Math.max(256, Math.floor(contextTokens * 0.25));
  }
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), 120000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (signal && signal.aborted) throw new LLMError('cancelled');
    throw new LLMTimeout();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  if (res.status === 401 || res.status === 403) throw new LLMAuthError();
  if (res.status === 404) throw new LLMBadEndpoint();
  if (!res.ok) throw new LLMHttpError(res.status);
  let data;
  try { data = await res.json(); } catch { throw new LLMBadEndpoint(); }
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!msg) throw new LLMBadEndpoint();
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content
    : (typeof msg.reasoning === 'string' ? msg.reasoning : null);
  const thinkStrip = thinking !== 'off';
  const content = normalize(msg.content, reasoning, thinkStrip);
  const parsed = extractJson(content);
  return { content, reasoning, raw: data, parsed };
}

module.exports = {
  LLMAuthError, LLMBadEndpoint, LLMTimeout, LLMHttpError,
  probeModels, chat, extractJson,
  THINK_OPEN, THINK_CLOSE,
};
