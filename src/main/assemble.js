'use strict';
/**
 * Assembly: chunk-local whisper output -> one global session timeline.
 *
 * `offsetSec` is the cumulative duration of captured audio before the chunk, including
 * partial chunks closed by Pause. It is the ONLY link to the single audio timeline; never
 * recompute it as index * chunkSec. See docs/session-schema.md and docs/transcription-pipeline.md.
 */
const SENTENCE_END = /[.!?…]["')\]]?$/;
const MAX_WORDS = 2_500_000;

/** Compare words ignoring case and punctuation. */
function norm(w) {
  return String(w ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Shift chunk-local words into absolute session time. */
function toGlobal(chunk, words) {
  const off = Number(chunk.offsetSec) || 0;
  return words.map((w) => ({
    t: Number((off + w.t).toFixed(3)),
    d: Number((w.d || 0).toFixed(3)),
    w: w.w,
    chunk: chunk.index,
  }));
}

/**
 * Drop the word whisper repeats across a chunk seam: the same word closing chunk N and
 * opening chunk N+1. Without this the global list holds two near-identical entries and the
 * active-word highlight visibly jumps between them.
 */
function dedupeSeam(words) {
  const out = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.chunk !== w.chunk &&
      norm(prev.w) &&
      norm(prev.w) === norm(w.w) &&
      w.t - (prev.t + prev.d) < 0.9
    ) {
      continue; // seam duplicate
    }
    out.push(w);
  }
  return out;
}

/**
 * Force a non-decreasing timeline. Whisper occasionally emits a word marginally before the
 * previous one; the highlight binary-search then jumps backwards.
 */
function enforceMonotonic(words) {
  for (let i = 1; i < words.length; i++) {
    if (words[i].t < words[i - 1].t) words[i].t = words[i - 1].t;
  }
  return words;
}

/**
 * Sentence-ish segments for reading + export.
 *
 * Boundaries are INDEX RANGES into `words`. The previous version matched words to segments
 * by timestamp range, which duplicated words whenever ranges overlapped - the root cause of
 * the "same word appears twice and the highlight flickers" report.
 */
function toSegments(words, { maxGapSec = 0.9, maxWords = 40 } = {}) {
  const segs = [];
  if (!words.length) return segs;

  let startIdx = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const gap = next ? next.t - (w.t + w.d) : Infinity;
    const isLast = i === words.length - 1;
    const tooLong = i - startIdx + 1 >= maxWords;

    if (isLast || gap > maxGapSec || SENTENCE_END.test(w.w) || tooLong) {
      const slice = words.slice(startIdx, i + 1);
      const tail = slice[slice.length - 1];
      segs.push({
        start: slice[0].t,
        end: Number((tail.t + tail.d).toFixed(3)),
        text: slice.map((x) => x.w).join(' ').replace(/\s+([,.;:!?])/g, '$1'),
        from: startIdx,
        to: i,
      });
      startIdx = i + 1;
    }
  }
  return segs;
}

/** Rebuild the whole transcript from all completed chunks. Idempotent. */
function rebuildTranscript(session) {
  const done = session.chunks
    .filter((c) => c.status === 'done' && Array.isArray(c.words))
    .sort((a, b) => a.index - b.index);

  let words = [];
  for (const c of done) {
    for (const w of toGlobal(c, c.words)) {
      if (words.length >= MAX_WORDS) break;
      words.push(w);
    }
  }

  words = enforceMonotonic(dedupeSeam(words));
  const segments = toSegments(words);
  const fullText = words.map((w) => w.w).join(' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  session.transcript = {
    language: session.model?.language || null,
    fullText,
    words,
    segments,
  };
  return session.transcript;
}

module.exports = {
  toGlobal, toSegments, rebuildTranscript, dedupeSeam, enforceMonotonic, norm,
};
