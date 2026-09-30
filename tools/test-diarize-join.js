'use strict';
/**
 * Unit test for the diarization turn -> word speaker join.
 *   node tools/test-diarize-join.js
 *
 * One section per join rule (src/main/diarize-join.js), plus id normalisation, the
 * session.json block shape, and a size sanity check (transcripts can hold millions of words).
 */
const {
  normalizeTurns, assignSpeakers, speakerNumber, isValidBlock, buildBlock, wordSpeakersFor,
} = require('../src/main/diarize-join');

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
}
const T = (start, end, speaker) => ({ start, end, speaker });
const W = (t, d = 0.3) => ({ t, d, w: 'x' });
const one = (word, turns) => assignSpeakers([word], turns)[0];

console.log('\n=== 1. contained words ===');
const ab = [T(0, 5, 'spk0'), T(5, 10, 'spk1')];
check('word inside the first turn', one(W(1), ab) === 'spk0');
check('word inside the second turn', one(W(6), ab) === 'spk1');

console.log('\n=== 2. the START decides; duration is ignored ===');
// whisper stretches the last word before a pause across the silence (observed: 1.3-1.8 s)
check('stretched last word stays with its speaker', one(W(4.7, 1.8), [T(0, 5, 'spk0'), T(6, 10, 'spk1')]) === 'spk0');
check('word starting just inside the next turn goes there', one(W(5.05, 0.1), ab) === 'spk1');
check('zero-duration word inside a turn', one(W(2, 0), ab) === 'spk0');
check('t on a boundary belongs to the turn that starts there', one(W(5, 0), ab) === 'spk1');

console.log('\n=== 3. silence gap: nearest turn within 1.0 s ===');
const gap = [T(0, 5, 'spk0'), T(7, 10, 'spk1')];
check('0.5 s after the first turn -> first', one(W(5.5, 0.2), gap) === 'spk0');
check('0.7 s before the second turn -> second', one(W(6.3, 0.3), gap) === 'spk1');
check('0.9 s after the first turn -> first', one(W(5.9, 0.2), gap) === 'spk0');
check('1.5 s from both -> null', one(W(6.5), [T(0, 5, 'spk0'), T(8, 10, 'spk1')]) === null);
check('equal distance -> preceding turn', one(W(5.5, 0.2), [T(0, 5, 'spk0'), T(6, 10, 'spk1')]) === 'spk0');
check('before the first turn, within the gap', one(W(0.1, 0.1), [T(0.5, 3, 'spk0')]) === 'spk0');
check('far after the last turn -> null', one(W(20), gap) === null);

console.log('\n=== 4. crosstalk (overlapping turns): earlier-starting turn ===');
check('start inside both -> the earlier turn', one(W(4.9, 0.6), [T(0, 5.2, 'spk0'), T(4, 10, 'spk1')]) === 'spk0');
check('start inside only the later turn -> it', one(W(5.3, 0.2), [T(0, 5.2, 'spk0'), T(4, 10, 'spk1')]) === 'spk1');
const long = [T(0, 100, 'spk0'), T(10, 12, 'spk1'), T(50, 52, 'spk2')];
check('scan reaches a long early turn past shorter ones', one(W(60, 0.5), long) === 'spk0');
check('inside nested turns -> the enclosing earlier one', one(W(51, 0.5), long) === 'spk0');
check('gap after a nested turn is still inside the long one', one(W(12.5, 0), long) === 'spk0');

console.log('\n=== 5. gap measured from the latest-ending earlier turn ===');
check('a long turn that ended later wins over a short recent one',
  one(W(21.5), [T(0, 21, 'spk0'), T(5, 6, 'spk1')]) === 'spk0');

console.log('\n=== 6. degenerate input ===');
check('no turns -> all null', assignSpeakers([W(1), W(2)], []).every((s) => s === null));
check('non-finite t -> null', one({ t: NaN, d: 0.2, w: 'x' }, ab) === null);
check('output length equals input length', assignSpeakers([W(1), W(2), W(3)], ab).length === 3);

console.log('\n=== 7. normalisation ===');
const raw = [
  T(8, 9, 'speaker_1'),
  T(0, 2, 'speaker_3'),
  T(3, 4, 'speaker_1'),
  T(5, 5, 'speaker_2'),          // zero length -> dropped
  { start: 'x', end: 2, speaker: 'speaker_9' }, // not a number -> dropped
  T(6, 7, 0),                     // numeric id is fine
];
const norm = normalizeTurns(raw);
check('invalid turns dropped', norm.length === 4, `${norm.length}`);
check('sorted by start', norm.every((t, i) => i === 0 || t.start >= norm[i - 1].start));
check('first voice heard is spk0', norm[0].speaker === 'spk0' && norm[1].speaker === 'spk1');
check('same raw id -> same label', norm[1].speaker === norm[3].speaker);
check('numeric raw id becomes its own label', norm[2].speaker === 'spk2');
check('speakerNumber is 1-based', speakerNumber('spk0') === 1 && speakerNumber('spk7') === 8);
check('speakerNumber(null) is null', speakerNumber(null) === null);

console.log('\n=== 8. session.json block ===');
const block = buildBlock({ turns: raw, engine: 'nemo-speech test', model: 'm', audioSec: 9.004 });
check('block is version 1', block.version === 1);
check('speakers counted after cleaning', block.speakers === 3, `${block.speakers}`);
check('turns stored normalised', block.turns[0].speaker === 'spk0' && block.turns.length === 4);
check('audioSec rounded', block.audioSec === 9);
check('valid block accepted', isValidBlock(block));
check('turns must be an array', !isValidBlock({ turns: 'x' }) && !isValidBlock(null));
const session = { transcript: { words: [W(0.5), W(8.2)] }, diarization: block };
const spk = wordSpeakersFor(session);
check('wordSpeakersFor aligns with transcript.words', spk.length === 2 && spk[0] === 'spk0' && spk[1] === 'spk1',
  JSON.stringify(spk));
check('wordSpeakersFor(no block) is null', wordSpeakersFor({ transcript: { words: [] } }) === null);

console.log('\n=== 9. scale ===');
const turns = [];
for (let i = 0; i < 5000; i++) turns.push(T(i * 2, i * 2 + 1.8, `s${i % 4}`));
const words = [];
for (let i = 0; i < 1_000_000; i++) words.push({ t: i * 0.01, d: 0.008, w: 'w' });
const t0 = Date.now();
const res = assignSpeakers(words, normalizeTurns(turns));
const ms = Date.now() - t0;
check('1M words x 5k turns under 2 s', ms < 2000, `${ms} ms`);
check('every word inside a turn got a speaker', res[5] && res[150] && res[9999], `${res[5]} ${res[150]}`);

console.log('\n=== 10. AGENTS.md recipe 4.6 agrees with assignSpeakers ===');
{
  const { spawnSync } = require('child_process');
  const manifest = require('../src/main/agent-manifest');
  const recipe = manifest.render({}).split('### 4.6')[1]?.match(/```python\n([\s\S]*?)```/)?.[1];
  check('recipe 4.6 has a python block', !!recipe);
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const cases = [];
  for (let c = 0; c < 1000; c++) {
    const raw2 = [];
    let t = 0;
    for (let i = 0; i < 6; i++) {
      const s = +(t + rnd() * 2 - 0.5).toFixed(2);
      const e = +(s + 0.2 + rnd() * 3).toFixed(2);
      raw2.push(T(Math.max(0, s), e, `s${Math.floor(rnd() * 3)}`));
      t = e + rnd() * 1.5;
    }
    const nt = normalizeTurns(raw2);
    const ws = [];
    for (let i = 0; i < 30; i++) ws.push({ t: +(rnd() * t).toFixed(2), d: rnd() < 0.2 ? 0 : +(rnd() * 0.6).toFixed(2) });
    cases.push({ turns: nt, words: ws, js: assignSpeakers(ws, nt) });
  }
  const py = `import json,sys\n${recipe}\ncases=json.load(sys.stdin)\n` +
    'print(sum(1 for c in cases for w,j in zip(c["words"],c["js"]) if speaker_of(w,c["turns"])!=j))\n';
  const run = ['python', 'py', 'python3']
    .map((bin) => spawnSync(bin, ['-c', py], { input: JSON.stringify(cases), encoding: 'utf8', windowsHide: true }))
    .find((r) => r.status === 0);
  if (!run) console.log('  SKIP  no python interpreter on PATH');
  else check('30k random words: python recipe == JS join', run.stdout.trim() === '0', `${run.stdout.trim()} mismatches`);
}

console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
