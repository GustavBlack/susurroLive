'use strict';
/**
 * Speaker join: diarization turns (who spoke when, on the audio) -> a speaker per word.
 *
 * Only the TURNS are persisted (session.json -> diarization.turns). A word's speaker is always
 * DERIVED here, at send/export time, because transcript.words is rebuilt from the chunks on
 * every open and every chunkDone - seam de-dup can drop words, so word indices are not stable.
 * The audio never changes after stop/import, so turns never go stale.
 *
 * Both timelines are global session seconds: full.wav is the chunks concatenated in index
 * order and offsetSec is cumulative captured audio, so turn time == transcript.words[].t.
 *
 * The same rule is documented for agents in AGENTS.md (agent-manifest.js, recipe 4.6).
 */

/** A word starting in a silence gap takes the nearest turn within this distance. */
const MAX_GAP_SEC = 1.0;
const EPS = 1e-9;

const r3 = (n) => Number(n.toFixed(3));

/**
 * Clean, sort and relabel raw turns. Speaker ids become spk0..spkN in order of first
 * appearance, so the first voice heard is always spk0 and colours stay stable across re-runs.
 * @param {Array<{start:number,end:number,speaker:any}>} turns
 * @returns {Array<{start:number,end:number,speaker:string}>}
 */
function normalizeTurns(turns) {
  const clean = (Array.isArray(turns) ? turns : [])
    .filter((t) => t && Number.isFinite(t.start) && Number.isFinite(t.end) && t.end > t.start
      && t.speaker !== undefined && t.speaker !== null && t.speaker !== '')
    .map((t) => ({ start: Math.max(0, t.start), end: t.end, speaker: String(t.speaker) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const ids = new Map();
  return clean.map((t) => {
    if (!ids.has(t.speaker)) ids.set(t.speaker, `spk${ids.size}`);
    return { start: r3(t.start), end: r3(t.end), speaker: ids.get(t.speaker) };
  });
}

/** Number of distinct speakers in normalized turns. */
function speakerCount(turns) {
  return new Set((turns || []).map((t) => t.speaker)).size;
}

/** 'spk0' -> 1. Unknown / null -> null. */
function speakerNumber(id) {
  const m = /^spk(\d+)$/.exec(String(id ?? ''));
  return m ? Number(m[1]) + 1 : null;
}

/** Is this a structurally usable session.json diarization block? */
function isValidBlock(block) {
  return !!block && typeof block === 'object' && Array.isArray(block.turns);
}

/** Last index i with turns[i].start <= x, or -1. */
function lastStartAtOrBefore(turns, x) {
  let lo = 0;
  let hi = turns.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (turns[mid].start <= x) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

/**
 * Assign a speaker id (or null) to every word.
 *
 * A word belongs to whoever is talking when it STARTS. Whisper's word starts are reliable but
 * its durations are not: the last word before a pause routinely absorbs the silence (1-2 s),
 * so overlap- or midpoint-based rules hand it to the next speaker. On a 3-voice fixture with
 * text ground truth: start point 97.6%, largest overlap 92.9%, midpoint 92.3%.
 *   1. the turn containing t (crosstalk: the earlier-starting turn);
 *   2. else the nearest turn edge within MAX_GAP_SEC (tie -> the preceding turn);
 *   3. else null.
 *
 * O(n log m): turns may overlap each other (crosstalk), so a running max of `end` bounds the
 * backward scan from the binary-search hit.
 *
 * @param {Array<{t:number}>} words  global-timeline words
 * @param {Array<{start:number,end:number,speaker:string}>} turns  normalized (sorted) turns
 * @returns {Array<string|null>} one entry per word
 */
function assignSpeakers(words, turns, { maxGapSec = MAX_GAP_SEC } = {}) {
  const list = Array.isArray(words) ? words : [];
  const out = new Array(list.length).fill(null);
  if (!Array.isArray(turns) || turns.length === 0) return out;

  // maxEnd[i] = largest end among turns[0..i]; maxEndIdx[i] = the EARLIEST turn achieving it.
  const maxEnd = new Float64Array(turns.length);
  const maxEndIdx = new Int32Array(turns.length);
  for (let i = 0; i < turns.length; i++) {
    if (i === 0 || turns[i].end > maxEnd[i - 1]) {
      maxEnd[i] = turns[i].end;
      maxEndIdx[i] = i;
    } else {
      maxEnd[i] = maxEnd[i - 1];
      maxEndIdx[i] = maxEndIdx[i - 1];
    }
  }

  for (let k = 0; k < list.length; k++) {
    const t = Number(list[k]?.t);
    if (!Number.isFinite(t)) continue;

    // 1: containing turn. Walking backwards, the last hit is the earliest-starting one.
    const hi = lastStartAtOrBefore(turns, t);
    let holder = -1;
    for (let j = hi; j >= 0 && maxEnd[j] > t; j--) {
      if (t < turns[j].end) holder = j;
    }
    if (holder >= 0) { out[k] = turns[holder].speaker; continue; }

    // 2: nearest edge - the turn that ended last before t, or the next one to start.
    let near = -1;
    let dist = Infinity;
    if (hi >= 0) {
      near = maxEndIdx[hi];
      dist = t - maxEnd[hi];
    }
    const next = hi + 1;
    if (next < turns.length) {
      const dn = turns[next].start - t;
      if (dn < dist - EPS) { near = next; dist = dn; }
    }
    if (near >= 0 && dist <= maxGapSec + EPS) out[k] = turns[near].speaker;
  }
  return out;
}

/**
 * Build the session.json block from a successful diarizer run.
 * @param {{turns:Array, engine?:string, model?:string, audioSec?:number}} res
 */
function buildBlock({ turns, engine, model, audioSec }) {
  const norm = normalizeTurns(turns);
  return {
    version: 1,
    engine: engine || 'nemo-speech',
    model: model || null,
    createdAt: new Date().toISOString(),
    audioSec: Number.isFinite(audioSec) ? Number(audioSec.toFixed(2)) : null,
    speakers: speakerCount(norm),
    turns: norm,
  };
}

/** Derived per-word speakers for a session, or null when it has no usable block. */
function wordSpeakersFor(session) {
  const block = session?.diarization;
  if (!isValidBlock(block)) return null;
  return assignSpeakers(session.transcript?.words || [], block.turns);
}

module.exports = {
  MAX_GAP_SEC,
  normalizeTurns,
  assignSpeakers,
  speakerCount,
  speakerNumber,
  isValidBlock,
  buildBlock,
  wordSpeakersFor,
};
