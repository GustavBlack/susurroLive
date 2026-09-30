'use strict';
/**
 * End-to-end engine check (no GUI).
 *   node tools/test-engine.js [binDir] [modelDir] [audioFile]
 * Verifies: engine status, real transcription, word timestamps, and offset-shifted assembly.
 */
const path = require('path');
const { Engine } = require('../src/main/whisper');
const { rebuildTranscript } = require('../src/main/assemble');

(async () => {
  const binDir = process.argv[2] || path.join(__dirname, '..', 'native', 'bin');
  const modelDir = process.argv[3] || path.join(__dirname, '..', 'native', 'models');
  const audio = process.argv[4] || path.join(__dirname, '..', 'native', 'src', 'whisper.cpp', 'samples', 'jfk.wav');
  const modelId = process.argv[5] || 'small.en';

  const engine = new Engine({ binDir, modelDir });
  const st = engine.status();
  console.log('--- engine status ---');
  console.log(JSON.stringify({
    available: st.available,
    binary: st.binary,
    binaryCuda: st.binaryCuda,
    models: st.models.map((m) => `${m.id} (${m.mb}MB)`),
    reason: st.reason,
  }, null, 2));

  console.log('\n--- transcribing', path.basename(audio), 'with', modelId, '---');
  const t0 = Date.now();
  const res = await engine.transcribe(audio, { model: modelId, language: 'en', chunkIndex: 0 });
  const ms = Date.now() - t0;

  console.log(`engine     : ${res.engine}`);
  console.log(`words      : ${res.words.length}`);
  console.log(`elapsed    : ${ms} ms`);
  console.log(`first 12   : ${res.words.slice(0, 12).map((w) => `${w.t.toFixed(2)}·${w.w}`).join('  ')}`);

  if (res.engine !== 'whisper') {
    console.log('\n!! DEMO MODE - the native engine did not run. See reason above.');
    process.exit(2);
  }

  console.log('\n--- assembly (chunk 0 at offset 0) ---');
  const s1 = { chunks: [{ index: 0, offsetSec: 0, status: 'done', words: res.words }], model: { language: 'en' } };
  const t1 = rebuildTranscript(s1);
  console.log(`segments : ${t1.segments.length}`);
  console.log(`text     : ${t1.fullText.slice(0, 180)}...`);

  console.log('\n--- assembly (same words as chunk 1 at offset 60) ---');
  const s2 = { chunks: [{ index: 1, offsetSec: 60, status: 'done', words: res.words.map((w) => ({ ...w, t: w.t })) }], model: { language: 'en' } };
  const t2 = rebuildTranscript(s2);
  const local0 = res.words[0]?.t ?? 0;
  const glob0 = t2.words[0]?.t ?? 0;
  console.log(`local first : ${local0.toFixed(3)}`);
  console.log(`global first: ${glob0.toFixed(3)}   (expect local + 60)`);
  const ok = Math.abs(glob0 - (local0 + 60)) < 0.002;
  console.log(`offset shift: ${ok ? 'PASS' : 'FAIL'}`);

  console.log('\nRESULT:', res.engine === 'whisper' && ok ? 'PASS' : 'FAIL');
  process.exit(res.engine === 'whisper' && ok ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
