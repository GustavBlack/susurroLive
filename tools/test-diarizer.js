'use strict';
/**
 * Diarizer sidecar module test (no real model needed).
 *   node tools/test-diarizer.js
 *
 * Drives src/main/diarizer.js against tools/fake-diarizer.js through the `cmd` override and
 * a fixture session of two 48 kHz mono chunks with NO full.wav, asserting that it builds the
 * global-timeline audio, passes the right arguments, parses the CLI JSON, and turns every
 * failure into {ok:false} instead of a throw.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WavWriter, readHeader, HEADER_BYTES } = require('../src/main/wav');
const diarizer = require('../src/main/diarizer');

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-diarizer-'));
const folder = path.join(root, 'session');
const modelDir = path.join(root, 'models');
const emptyBin = path.join(root, 'bin');
for (const d of [path.join(folder, 'audio'), modelDir, emptyBin]) fs.mkdirSync(d, { recursive: true });

// two chunks: 1.5 s of a 220 Hz tone, then 1.0 s of a 330 Hz tone (48 kHz PCM16 mono)
function writeChunk(i, sec, hz) {
  const file = path.join(folder, 'audio', `chunk_${String(i).padStart(4, '0')}.wav`);
  const w = new WavWriter(file, { sampleRate: 48000 }).open();
  const n = Math.round(sec * 48000);
  const pcm = Buffer.alloc(n * 2);
  for (let s = 0; s < n; s++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * s) / 48000) * 8000), s * 2);
  w.write(pcm);
  w.close();
  return { index: i, offsetSec: i === 0 ? 0 : 1.5, durationSec: sec, audioFile: `audio/chunk_${String(i).padStart(4, '0')}.wav`, status: 'done' };
}
const session = { folder, chunks: [writeChunk(1, 1.0, 330), writeChunk(0, 1.5, 220)] }; // out of order on purpose
fs.writeFileSync(path.join(modelDir, 'nemotron-3-diarization-bf16.gguf'), 'x');
fs.writeFileSync(path.join(modelDir, 'Nemotron-3-Diarization.q8_0.gguf'), 'x');

const fake = path.join(__dirname, 'fake-diarizer.js');
const argsFile = path.join(root, 'args.json');
const cmd = (mode) => ({
  exe: process.execPath,
  argsPrefix: [fake],
  env: { FAKE_DIAR_MODE: mode, FAKE_DIAR_ARGS: argsFile, ELECTRON_RUN_AS_NODE: '1' },
});
const base = { session, repoRoot: root, binDir: emptyBin, modelDir };

(async () => {
  console.log('\n=== 1. happy path ===');
  const full = path.join(folder, 'audio', 'full.wav');
  check('fixture starts without full.wav', !fs.existsSync(full));
  const r = await diarizer.runDiarize({ ...base, cmd: cmd('ok') });
  check('resolves ok', r.ok, r.error);
  check('full.wav built from the chunks', fs.existsSync(full));
  const h = fs.existsSync(full) ? readHeader(full) : {};
  check('full.wav keeps the session format (48 kHz mono)', h.sampleRate === 48000 && h.channels === 1);
  check('full.wav is 2.5 s (both chunks, index order)', Math.abs((r.audioSec || 0) - 2.5) < 0.001, `${r.audioSec}`);
  const pcm = fs.readFileSync(full).subarray(HEADER_BYTES);
  const firstChunk = fs.readFileSync(path.join(folder, 'audio', 'chunk_0000.wav')).subarray(HEADER_BYTES);
  check('chunk 0 comes first in full.wav', pcm.subarray(0, 4000).equals(firstChunk.subarray(0, 4000)));
  const seen = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  const args = seen.args;
  const n = Number(seen.threads);
  check('passes a CPU thread count (half the cores, 4..16)', n >= 4 && n <= 16, `${seen.threads}`);
  check('invokes `diarize <full.wav>`', args[0] === 'diarize' && args[1] === full, args.slice(0, 2).join(' '));
  check('prefers the q8_0 model', args[args.indexOf('--model') + 1] === path.join(modelDir, 'Nemotron-3-Diarization.q8_0.gguf'));
  check('asks for JSON, quietly', args.includes('--format') && args[args.indexOf('--format') + 1] === 'json' && args.includes('--quiet'));
  check('degenerate segment dropped', r.turns?.length === 3, `${r.turns?.length}`);
  check('turns sorted by start', r.turns?.every((t, i) => i === 0 || t.start >= r.turns[i - 1].start));
  check('model id reported', r.model === 'Nemotron-3-Diarization.q8_0');

  console.log('\n=== 1b. downsampled to 16 kHz with ffmpeg (less RAM) ===');
  const ff = require('../src/main/ffmpeg').findFfmpeg(path.join(__dirname, '..'));
  if (!ff) console.log('  SKIP  no ffmpeg');
  else {
    const r16 = await diarizer.runDiarize({ ...base, ffmpegPath: ff, cmd: cmd('ok') });
    const s16 = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    check('resolves ok', r16.ok, r16.error);
    check('sidecar received a 16 kHz temp file', s16.sampleRate === 16000 && /diar_16k\.wav$/.test(s16.args[1]), `${s16.sampleRate} ${s16.args[1]}`);
    check('temp file removed afterwards', !fs.existsSync(path.join(folder, 'temp', 'diar_16k.wav')));
    check('audioSec still from the session audio', Math.abs(r16.audioSec - 2.5) < 0.001);
    const rBad = await diarizer.runDiarize({ ...base, ffmpegPath: path.join(root, 'nope.exe'), cmd: cmd('ok') });
    const sBad = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    check('broken ffmpeg falls back to full.wav', rBad.ok && sBad.args[1] === full && sBad.sampleRate === 48000);
  }

  console.log('\n=== 2. stale full.wav is rebuilt ===');
  fs.writeFileSync(full, fs.readFileSync(full).subarray(0, 1000));
  const r2 = await diarizer.runDiarize({ ...base, cmd: cmd('ok') });
  check('rebuilt to the full length', r2.ok && Math.abs(r2.audioSec - 2.5) < 0.001, `${r2.audioSec}`);

  console.log('\n=== 3. failures come back as {ok:false} ===');
  const fail = await diarizer.runDiarize({ ...base, cmd: cmd('fail') });
  check('nonzero exit -> ok:false', fail.ok === false);
  check('error carries the stderr tail', /model file is corrupt/.test(fail.error || ''), fail.error);
  const bad = await diarizer.runDiarize({ ...base, cmd: cmd('badjson') });
  check('malformed JSON -> ok:false', bad.ok === false && /malformed/.test(bad.error || ''), bad.error);
  const hang = await diarizer.runDiarize({ ...base, cmd: cmd('hang'), timeoutMs: 800 });
  check('hang -> timed out', hang.ok === false && /timed out/.test(hang.error || ''), hang.error);
  const noModel = await diarizer.runDiarize({ ...base, modelDir: emptyBin, cmd: cmd('ok') });
  check('missing model -> ok:false', noModel.ok === false && /gguf/.test(noModel.error || ''), noModel.error);
  const noAudio = await diarizer.runDiarize({ ...base, session: { folder: root, chunks: [] }, cmd: cmd('ok') });
  check('no audio -> ok:false', noAudio.ok === false && /no audio/.test(noAudio.error || ''), noAudio.error);
  const noSession = await diarizer.runDiarize({ ...base, session: null });
  check('no session -> ok:false', noSession.ok === false);
  const savedEnv = process.env.SUSURRO_DIARIZER;
  delete process.env.SUSURRO_DIARIZER;
  const noExe = await diarizer.runDiarize({ ...base });
  if (savedEnv !== undefined) process.env.SUSURRO_DIARIZER = savedEnv;
  check('missing exe -> ok:false naming the exe', noExe.ok === false && /nemo-speech\.exe/.test(noExe.error || ''), noExe.error);

  console.log('\n=== 4. status + discovery ===');
  const st = diarizer.status({ repoRoot: root, binDir: emptyBin, modelDir });
  check('status: unavailable without exe', st.available === false && st.model === 'Nemotron-3-Diarization.q8_0');
  const dropIn = path.join(emptyBin, diarizer.SUBDIR);
  fs.mkdirSync(dropIn, { recursive: true });
  fs.writeFileSync(path.join(dropIn, diarizer.EXE), '');
  const st2 = diarizer.status({ repoRoot: root, binDir: emptyBin, modelDir });
  check('status: exe dropped into bin/diarizer/ is found without a restart',
    st2.available === true && st2.binary === path.join(dropIn, diarizer.EXE), st2.binary);

  console.log('\n=== 5. parser ===');
  const turns = diarizer.parseDiarJson('{"file":"a.wav","segments":[{"start":1,"end":2,"speaker":2},{"start":0,"end":0.5,"speaker":1}]}');
  check('parses and sorts', turns.length === 2 && turns[0].start === 0 && turns[0].speaker === 1);
  let threw = false;
  try { diarizer.parseDiarJson('{"file":"a.wav"}'); } catch { threw = true; }
  check('missing segments throws inside (caught by runDiarize)', threw);

  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
