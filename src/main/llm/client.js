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

// The checkup asks for a tiny JSON answer, but thinking models happily burn thousands of
// reasoning tokens on it (measured on the local GLM-5.3-Flash: 4.9k reasoning tokens and ~90 s
// for a 200-word batch, vs 1.6 s with thinking disabled). So the request asks the server to skip
// thinking via `chat_template_kwargs` (vLLM/GLM convention) and keeps a small max_tokens; if a
// server rejects that field (400) or answers with empty content (a model that ignores the hint
// and spends its whole budget thinking), retry once WITHOUT the hint and a thinking-sized budget.
const MAX_TOKENS_FAST = 2048;
const MAX_TOKENS_THINK = 8192;
const REQUEST_TIMEOUT_MS = 300000;

function bodyFor({ model, messages, temperature, contextTokens, fast }) {
  const body = {
    model,
    messages,
    temperature: typeof temperature === 'number' ? temperature : 0,
    stream: false,
  };
  const cap = fast ? MAX_TOKENS_FAST : MAX_TOKENS_THINK;
  const byCtx = Number.isFinite(contextTokens) && contextTokens > 0
    ? Math.max(256, Math.floor(contextTokens * 0.25))
    : cap;
  body.max_tokens = Math.min(cap, byCtx);
  if (fast) body.chat_template_kwargs = { enable_thinking: false };
  return body;
}

async function postOnce({ url, key, body, signal }) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { res, text };
  } catch (e) {
    if (signal && signal.aborted) throw new LLMError('cancelled');
    throw new LLMTimeout();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function rejectsThinkingHint(text, status) {
  if (status !== 400) return false;
  return /chat_template_kwargs|enable_thinking|unknown|unexpected|extra/i.test(text || '');
}

async function chat({ base, key, model, messages, contextTokens, signal, temperature, thinking }) {
  const url = String(base || '').replace(/\/+$/, '') + '/chat/completions';
  const fast = thinking !== 'on';            // 'auto' and 'off' both try the no-thinking path

  let attempt = await postOnce({
    url, key, signal,
    body: bodyFor({ model, messages, temperature, contextTokens, fast }),
  });

  // Server doesn't know the hint — drop it and think normally.
  if (fast && rejectsThinkingHint(attempt.text, attempt.res.status)) {
    attempt = await postOnce({
      url, key, signal,
      body: bodyFor({ model, messages, temperature, contextTokens, fast: false }),
    });
  }

  let { res, text } = attempt;
  if (res.status === 401 || res.status === 403) throw new LLMAuthError();
  if (res.status === 404) throw new LLMBadEndpoint();
  if (!res.ok) throw new LLMHttpError(res.status);
  let data;
  try { data = JSON.parse(text); } catch { throw new LLMBadEndpoint(); }
  let msg = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!msg) throw new LLMBadEndpoint();

  // The hint was accepted but ignored: the model thought through its whole small budget and
  // returned no content. Retry once with the thinking-sized budget before giving up.
  const empty = !msg.content || !String(msg.content).trim();
  if (fast && empty && thinking !== 'off') {
    attempt = await postOnce({
      url, key, signal,
      body: bodyFor({ model, messages, temperature, contextTokens, fast: false }),
    });
    ({ res, text } = attempt);
    if (res.status === 401 || res.status === 403) throw new LLMAuthError();
    if (res.status === 404) throw new LLMBadEndpoint();
    if (!res.ok) throw new LLMHttpError(res.status);
    try { data = JSON.parse(text); } catch { throw new LLMBadEndpoint(); }
    msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new LLMBadEndpoint();
  }

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
