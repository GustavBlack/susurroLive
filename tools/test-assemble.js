'use strict';
/**
 * Unit test for the transcript assembly fixes.
 *   node tools/test-assemble.js
 *
 * Covers the three reported problems:
 *   1. the same word duplicated across a chunk seam
 *   2. out-of-order timestamps making the highlight jump backwards
 *   3. segments matching words by timestamp, which duplicated words in the DOM
 */
const { rebuildTranscript, toSegments, dedupeSeam, enforceMonotonic } = require('../src/main/assemble');

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
}

console.log('\n=== 1. seam duplication ===');
// chunk 0 ends with "word" at 4.9s (ends 5.2); chunk 1 (offset 5) opens with "word" at 5.2s
const chunk0 = {
  index: 0, offsetSec: 0, status: 'done',
  words: [
    { t: 3.9, d: 0.3, w: 'the' },
    { t: 4.6, d: 0.3, w: 'next' },
    { t: 4.9, d: 0.3, w: 'word' },
  ],
};
const chunk1 = {
  index: 1, offsetSec: 5, status: 'done',
  words: [
    { t: 0.2, d: 0.3, w: 'word' },   // <- duplicate across the seam
    { t: 0.6, d: 0.3, w: 'again' },
    { t: 1.0, d: 0.3, w: 'please' },
  ],
};
const session = { chunks: [chunk0, chunk1], model: { language: 'en' } };
const tr = rebuildTranscript(session);

console.log('  words:', tr.words.map((w) => `${w.t}:${w.w}`).join(' '));
check('duplicate seam word dropped', tr.words.length === 5, `got ${tr.words.length}, expected 5`);
const wordCounts = {};
for (const w of tr.words) wordCounts[w.w] = (wordCounts[w.w] || 0) + 1;
check('"word" appears exactly once', wordCounts.word === 1, `count=${wordCounts.word}`);

console.log('\n=== 2. monotonic timeline ===');
const jumbled = [
  { t: 1.0, d: 0.3, w: 'a' },
  { t: 1.4, d: 0.3, w: 'b' },
  { t: 1.2, d: 0.3, w: 'c' },   // out of order
  { t: 0.5, d: 0.3, w: 'd' },   // badly out of order
  { t: 2.0, d: 0.3, w: 'e' },
];
enforceMonotonic(jumbled);
check('timeline non-decreasing', jumbled.every((w, i) => i === 0 || w.t >= jumbled[i - 1].t),
  jumbled.map((w) => w.t).join(','));

console.log('\n=== 3. segments use index ranges (no word duplication) ===');
const words = tr.words;
const segs = tr.segments;
console.log('  segments:', segs.map((s) => `[${s.from}..${s.to}]`).join(' '));

let contiguous = true;
let expectedFrom = 0;
for (const s of segs) {
  if (s.from !== expectedFrom) contiguous = false;
  expectedFrom = s.to + 1;
}
check('segments are contiguous index ranges', contiguous);
check('segments cover every word exactly once', expectedFrom === words.length,
  `covered ${expectedFrom} of ${words.length}`);

// reconstructing text from segment slices must equal the word list (no dupes, no gaps)
const rebuilt = [];
for (const s of segs) for (const w of words.slice(s.from, s.to + 1)) rebuilt.push(w);
check('segment reconstruction matches words[]', rebuilt.length === words.length,
  `${rebuilt.length} vs ${words.length}`);

console.log('\n=== 4. legitimate repeats inside one chunk are preserved ===');
const sameChunk = dedupeSeam([
  { t: 0.0, d: 0.3, w: 'very', chunk: 0 },
  { t: 0.3, d: 0.3, w: 'very', chunk: 0 },
]);
check('in-chunk repetition kept', sameChunk.length === 2, `got ${sameChunk.length}`);

console.log('\n=== 5. fullText is punctuation-clean ===');
console.log('  fullText:', JSON.stringify(tr.fullText));
check('no space before punctuation', !/\s[,.;:!?]/.test(tr.fullText));
check('no double spaces', !/  /.test(tr.fullText));

console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
