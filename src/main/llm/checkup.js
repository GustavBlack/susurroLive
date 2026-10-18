'use strict';
/** Checkup harness — batches the transcript, prompts the LLM, and projects edits. */

const client = require('./client');

const PROMPT_OVERHEAD = 256; // system prompt + JSON framing, in estimated tokens
const PREAMBLE_WORDS = 40;   // leading context words attached to every batch

// ---------------------------------------------------------------- batching

/** Estimated prompt tokens for words[start..end): chars/4 heuristic, x1.3 safety. */
function estimateTokens(words, start, end, withSpeakers) {
  let chars = 0;
  for (let i = start; i < end; i++) {
    chars += words[i].w.length + 6; // "i|word" framing
    if (withSpeakers) chars += 4;   // "S1 " tag
  }
  return Math.ceil((chars / 4) * 1.3) + PROMPT_OVERHEAD;
}

/** Pure: split the global word timeline into batches that fit the context window. */
function buildBatches(words, contextTokens) {
  const ctx = Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : 8192;
  const reserve = Math.max(512, Math.floor(ctx * 0.25));
  const budget = ctx - reserve;
  const hasSpeakers = words.some((w) => w && typeof w.speaker === 'string');
  const batches = [];
  let start = 0;
  while (start < words.length) {
    let end = start + 1;
    while (end < words.length) {
      const est = estimateTokens(words, start, end + 1, hasSpeakers);
      if (est > budget) break;
      end++;
    }
    batches.push({ range: [start, end], preambleWords: [Math.max(0, start - PREAMBLE_WORDS), start] });
    start = end;
  }
  return batches;
}

// ---------------------------------------------------------------- prompting

const SYSTEM_PROMPT = [
  'You are correcting ASR (speech-to-text) output.',
  'Return ONLY a JSON object {"edits":[{"i":<index>,"w":"<replacement>"}]} — no prose, no markdown fences around the whole answer.',
  'Fix ONLY obvious transcription errors: wrong homophones, mangled proper nouns, wrong acronyms or version strings, duplicated stutters.',
  'Never add, delete, merge, or reorder words — one-to-one replacements only.',
  'Never change the casing of code-like tokens unless clearly wrong.',
  'Prefer leaving a word unchanged when unsure.',
].join(' ');

function buildMessages(words, batch, vocabulary, speakerAt) {
  const [ctxStart, ctxEnd] = batch.preambleWords;
  const [start, end] = batch.range;
  const lines = [];

  if (ctxEnd > ctxStart) {
    lines.push('context — do not edit:');
    for (let i = ctxStart; i < ctxEnd; i++) {
      const sp = speakerAt ? speakerAt(i) : null;
      lines.push((sp ? sp + ' ' : '') + '~|' + (words[i] ? words[i].w : ''));
    }
  }
  lines.push('words to review:');
  for (let i = start; i < end; i++) {
    const sp = speakerAt ? speakerAt(i) : null;
    lines.push((sp ? sp + ' ' : '') + i + '|' + words[i].w);
  }

  let user = lines.join('\n');
  if (vocabulary && vocabulary.length) {
    user = 'vocabulary (known terms — prefer these spellings):\n'
      + vocabulary.map((t) => '- ' + t).join('\n') + '\n\n' + user;
  }

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

// ---------------------------------------------------------------- parsing

/** Strict validator: keep only in-range, single-token, non-identity edits. */
function parseEdits(content, batchRange, words) {
  const parsed = client.extractJson(content);
  const list = parsed && Array.isArray(parsed.edits) ? parsed.edits : [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const i = e.i;
    if (!Number.isInteger(i) || i < batchRange[0] || i >= batchRange[1]) continue;
    if (typeof e.w !== 'string' || e.w === '' || /\s/.test(e.w)) continue;
    const orig = words[i] ? words[i].w : undefined;
    if (typeof orig !== 'string' || e.w === orig) continue;
    out.push({ i, orig, w: e.w });
  }
  return out;
}

// ---------------------------------------------------------------- fingerprints

/** FNV-1a (32-bit) hex over a space-joined string. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Per-chunk fingerprint map; words without a `chunk` field go under ''. */
function chunkHashes(words) {
  const buckets = new Map();
  for (const w of words) {
    const k = w && w.chunk != null ? String(w.chunk) : '';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(w.w);
  }
  const out = {};
  for (const [k, texts] of buckets) out[k] = fnv1a(texts.join(' '));
  return out;
}

// ---------------------------------------------------------------- projection

/**
 * Pure projection: apply an edit only when its word's chunk fingerprint still
 * matches `checkup.chunkHashes` AND the stored word still equals `edit.orig`.
 * Never mutates the input; t/d are copied through untouched. Drifted chunks
 * pass through as original words and are reported in `driftedChunkIds`.
 */
function applyCheckup(words, checkup) {
  const wordsOut = words.slice();
  const driftedChunkIds = [];
  if (!checkup || checkup.active === false || !Array.isArray(checkup.edits) || !checkup.edits.length) {
    return { words: wordsOut, driftedChunkIds };
  }

  const hashes = checkup.chunkHashes || {};
  const current = chunkHashes(words);

  // A chunk has drifted when its stored fingerprint is missing or no longer
  // matches the words as they exist now (checked over every fingerprinted chunk,
  // so a re-transcribed chunk is flagged even before its edits are re-derived).
  for (const key of Object.keys(hashes)) {
    if (current[key] !== hashes[key]) driftedChunkIds.push(key);
  }
  const driftedSet = new Set(driftedChunkIds);

  for (const e of checkup.edits) {
    if (!e || !Number.isInteger(e.i)) continue;
    const word = words[e.i];
    if (!word) continue;
    const chunkKey = word.chunk != null ? String(word.chunk) : '';
    if (driftedSet.has(chunkKey)) continue;
    if (word.w !== e.orig) continue; // belt-and-braces: stored word changed
    wordsOut[e.i] = { ...word, w: e.w };
  }

  return { words: wordsOut, driftedChunkIds };
}

// ---------------------------------------------------------------- orchestration

/**
 * Run the checkup over a finished session's transcript. Sequential batches,
 * typed errors from the client, cancel via AbortController. Does NOT persist —
 * the IPC layer owns session.json; this returns the full `checkup` block.
 */
async function runCheckup({ session, settings, signal, onProgress, chatFn, vocabulary }) {
  const words = (session && session.transcript && Array.isArray(session.transcript.words))
    ? session.transcript.words : [];
  if (!words.length) throw new Error('session has no transcript words to check');

  const contextTokens = Number(settings && settings.llmContextTokens) || 8192;
  const batches = buildBatches(words, contextTokens);
  const speakerAt = words.some((w) => typeof w.speaker === 'string')
    ? (i) => (words[i] && words[i].speaker) || null
    : null;

  const chat = chatFn || client.chat;
  const edits = [];
  for (let b = 0; b < batches.length; b++) {
    if (signal && signal.aborted) throw new Error('cancelled');
    const messages = buildMessages(words, batches[b], vocabulary, speakerAt);
    const res = await chat({
      base: settings.llmEndpoint,
      key: settings.llmApiKey,
      model: settings.llmModel,
      messages,
      contextTokens,
      signal,
      temperature: 0,
      thinking: settings.llmThinking,
    });
    edits.push(...parseEdits(res.content, batches[b].range, words));
    if (onProgress) onProgress({ done: b + 1, total: batches.length });
  }

  return {
    active: true,
    model: settings.llmModel,
    endpoint: settings.llmEndpoint,
    applied: edits.length,
    batches: batches.length,
    at: new Date().toISOString(),
    vocabulary: vocabulary || [],
    chunkHashes: chunkHashes(words),
    edits,
  };
}

module.exports = {
  PROMPT_OVERHEAD, PREAMBLE_WORDS, SYSTEM_PROMPT,
  estimateTokens, buildBatches, buildMessages, parseEdits,
  fnv1a, chunkHashes, applyCheckup, runCheckup,
};
