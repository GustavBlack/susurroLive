'use strict';
/**
 * Repetition-loop guard test — runs against a real whisper JSON dump.
 *   node tools/test-loopguard.js <whisper-output.json>
 */
const fs = require('fs');
const path = require('path');
const { cleanWhisperWords, collapseLoops, parseWhisperJson } = require('../src/main/whisper');

function loadRaw(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (doc.transcription || [])
    .map((t) => ({
      t: Number(t.offsets?.from ?? 0) / 1000,
      d: (Number(t.offsets?.to ?? 0) - Number(t.offsets?.from ?? 0)) / 1000,
      w: String(t.text ?? '').trim(),
    }))
    .filter((w) => w.w);
}

let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
};

// ---------- 1. real capture with a repetition loop ----------
const file = process.argv[2];
if (file && fs.existsSync(file)) {
  console.log(`\n=== real whisper output: ${path.basename(file)} ===`);
  const raw = loadRaw(file);
  const cleaned = parseWhisperJson(fs.readFileSync(file, 'utf8')).words;
  const stacked = raw.filter((w, i) => i > 0 && Math.abs(w.t - raw[i - 1].t) < 0.001).length;

  console.log(`  raw words     : ${raw.length}`);
  console.log(`  stacked words : ${stacked}  (all on one timestamp = degeneracy)`);
  console.log(`  cleaned words : ${cleaned.length}`);
  console.log(`  raw text      : ${raw.map((w) => w.w).join(' ').slice(0, 150)}`);
  console.log(`  cleaned text  : ${cleaned.map((w) => w.w).join(' ')}`);

  check('loop output reduced', cleaned.length < raw.length * 0.75,
    `${raw.length} -> ${cleaned.length}`);
  check('cleaned text is not the same phrase repeated 9x', !/ask not what your country can do for you.*ask not what your country can do for you.*ask not what your country can do for you.*ask not what your country can do for you.*ask not what your country can do for you/i.test(cleaned.map((w) => w.w).join(' ')));
  check('timeline still monotonic', cleaned.every((w, i) => i === 0 || w.t >= cleaned[i - 1].t));
  check('retained timing is finite and nonnegative', cleaned.every(w => Number.isFinite(w.t) && Number.isFinite(w.d) && w.d >= 0));
} else {
  console.log('\n(no JSON file given - running synthetic cases only)');
}

// ---------- 2. synthetic: a genuine 9x loop is collapsed ----------
console.log('\n=== synthetic loop ===');
const phrase = ['ask', 'not', 'what', 'your', 'country', 'can', 'do', 'for', 'you'];
const looped = [];
for (let r = 0; r < 9; r++) {
  phrase.forEach((w, k) => looped.push({ t: 10 + r * 3 + k * 0.3, d: 0.3, w }));
}
const fixed = collapseLoops(looped);
console.log(`  ${looped.length} words -> ${fixed.length} words`);
check('9 repetitions collapsed to <= 4', fixed.length <= phrase.length * 4, `${fixed.length}`);

// ---------- 3. synthetic: a legitimate double repeat is PRESERVED ----------
console.log('\n=== legitimate repetition (said twice) ===');
const twice = [];
for (let r = 0; r < 2; r++) phrase.forEach((w, k) => twice.push({ t: r * 4 + k * 0.3, d: 0.3, w }));
const kept = collapseLoops(twice);
check('said-twice preserved', kept.length === twice.length, `${twice.length} -> ${kept.length}`);

// ---------- 4. short repeating phrase inside normal speech is safe ----------
console.log('\n=== normal speech with "you you" ===');
const normal = [
  { t: 0, d: 0.3, w: 'I' }, { t: 0.3, d: 0.3, w: 'told' }, { t: 0.6, d: 0.3, w: 'you' },
  { t: 0.9, d: 0.3, w: 'you' }, { t: 1.2, d: 0.3, w: 'know' }, { t: 1.5, d: 0.3, w: 'that' },
];
check('short repeats untouched', collapseLoops(normal).length === normal.length);

// ---------- 5. alignment failures must not erase unique words ----------
console.log('\n=== valid text with shared / zero-duration timestamps ===');
const shared = [{ t: 0, d: 0, w: "I'm" }, { t: 0, d: 0, w: 'still' }, { t: 0, d: 0, w: 'here.' }];
check('unreliable timing preserves all text', cleanWhisperWords(shared).length === shared.length);
const stackedLoop = looped.map(w => ({ ...w, t: 14.4, d: 0 }));
check('actual repeated phrase still collapses with shared timing', cleanWhisperWords(stackedLoop).length === phrase.length * 4);

console.log(`\nRESULT: ${fails === 0 ? 'PASS' : `FAIL (${fails})`}`);
process.exit(fails === 0 ? 0 : 1);
