'use strict';
/**
 * Parakeet engine check (no GUI). Mirrors tools/test-engine.js.
 *   node tools/test-parakeet-engine.js [binDir] [modelDir] [audioFile]
 *
 * Without the sherpa-onnx exe / model provisioned, prints a SKIP line and exits 0 (the engine
 * is an optional peer, like the diarizer). With them, it runs REAL Parakeet transcription
 * over a speech WAV and asserts the engine contract: word timings monotonic and in bounds,
 * non-empty text, subwords joined into words.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const binDir = process.argv[2] || path.join(REPO_ROOT, 'native', 'bin');
const modelDir = process.argv[3] || path.join(REPO_ROOT, 'native', 'models');

const { ParakeetEngine, joinWords, parseSherpaJson } = require('../src/main/engines/parakeet');
const { WavWriter } = require('../src/main/wav');

let failed = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '  ok' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed++;
}

/** A sine tone is not speech, but it exercises the whole path: real decode, real decode-loop
 *  output shape, real timing math. ASR quality is NOT asserted here — that is the human test. */
function synthWav(out, seconds, sampleRate = 48000) {
  const w = new WavWriter(out, { sampleRate, channels: 1, bitsPerSample: 16 }).open();
  const half = Buffer.alloc(sampleRate);
  for (let i = 0; i < half.length; i += 2) {
    half.writeInt16LE(Math.round(8000 * Math.sin(i / 20)), i);
  }
  let remaining = seconds;
  while (remaining >= 0.5) { w.write(half); remaining -= 0.5; }
  if (remaining > 0) w.write(Buffer.alloc(Math.round(remaining * sampleRate * 2)));
  w.close();
  return out;
}

async function main() {
  console.log('--- parakeet engine status ---');
  const engine = new ParakeetEngine({
    repoRoot: REPO_ROOT,
    binDir,
    modelDir,
    ffmpegPath: '', // skip the 16 kHz temp copy in unit mode: feed the WAV directly
  });
  const st = engine.status();
  console.log(`binary : ${st.binary || 'not found'}`);
  console.log(`model  : ${st.model || 'not found'}`);
  if (!st.available) {
    console.log(`reason : ${st.reason}`);
    console.log('\nRESULT: SKIP (parakeet not provisioned - run scripts/fetch-parakeet.ps1)');
    return;
  }

  // ---- unit: word reconstruction from BPE subwords -------------------------------
  console.log('\n--- unit: joinWords (BPE subwords -> words) ---');
  const tokens = [' Well', ',', ' I', ' don', "'", 't', ' wish', ' to', ' see', ' it', ' any', ' more', '.', ' It', ' is', ' c', 'ertain', 'ly', ' very', ' like', ' the', ' o', 'ld', ' portrait', '.'];
  const stamps = [0.40, 0.64, 0.72, 0.80, 0.88, 0.92, 0.96, 1.04, 1.12, 1.28, 1.44, 1.60, 1.76, 1.92, 2.00, 2.08, 2.16, 2.24, 2.32, 2.40, 2.48, 2.56, 2.64, 2.72, 2.80];
  const durs = stamps.map((_, i) => (i % 3 === 0 ? 0.16 : 0.08));
  const words = joinWords(tokens, stamps, durs);
  check('subwords joined into words', words.length === 17, JSON.stringify(words.map((w) => w.w)));
  check('contraction joins without space', words.some((w) => w.w === "don't"), words.map((w) => w.w).join('|'));
  check('subword-only pieces join (certainly)', words.some((w) => w.w === 'certainly'));
  check('word t = first subword t', words[0].t === 0.40 && words[0].w === 'Well,');
  const last = words[words.length - 1];
  check('word d spans its subwords', Math.abs((last.t + last.d) - 2.96) < 1e-6, `${last.t}+${last.d}`);
  const mono = words.every((w, i) => i === 0 || w.t >= words[i - 1].t);
  check('word starts monotonic', mono);

  // ---- unit: parser guards -------------------------------------------------------
  console.log('\n--- unit: parseSherpaJson guards ---');
  const doc = { text: 'hello world', tokens: [' hello', ' world'], timestamps: [0.1, 0.5], durations: [0.2, 0.3] };
  const parsed = parseSherpaJson(JSON.stringify(doc));
  check('parses clean json', parsed.text === 'hello world' && parsed.tokens.length === 2);
  let threw = false;
  try { parseSherpaJson('not json at all'); } catch { threw = true; }
  check('malformed json throws a retry-safe error', threw);
  const partial = parseSherpaJson(JSON.stringify({ text: 'x' }));
  check('missing arrays become empty', partial.tokens.length === 0 && partial.timestamps.length === 0);

  // ---- e2e: real transcription over a speech wav ---------------------------------
  console.log('\n--- e2e: real parakeet transcription ---');
  const audioArg = process.argv[4];
  let wavPath = audioArg && fs.existsSync(audioArg) ? audioArg : '';
  let tmpDir = '';
  if (!wavPath) {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'parakeet-test-'));
    wavPath = path.join(tmpDir, 'tone.wav');
    synthWav(wavPath, 12);
    console.log(`synthesized tone wav: ${wavPath}`);
  }

  const res = await engine.transcribe(wavPath, { chunkIndex: 0 });
  console.log(`engine  : ${res.engine}`);
  console.log(`words   : ${res.words.length}`);
  console.log(`text    : ${res.text.slice(0, 120)}`);
  check('engine tag is parakeet', res.engine === 'parakeet');
  check('produced words', res.words.length > 0);
  check('produced text', res.text.trim().length > 0);
  const inBounds = res.words.every((w) => Number.isFinite(w.t) && w.t >= 0);
  check('word times finite and >= 0', inBounds);
  const wordMono = res.words.every((w, i) => i === 0 || w.t >= res.words[i - 1].t);
  check('word times monotonic', wordMono);
  const noRawSubwords = res.words.every((w) => !w.w.startsWith(' ') && !w.w.includes('▁'));
  check('no raw subword markers leaked', noRawSubwords);

  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ } }
  console.log(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
