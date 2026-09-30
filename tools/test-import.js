'use strict';
/**
 * Import end-to-end test (real ffmpeg, real Recorder, real chunk math):
 *   1. synthesize a 7.3 s WAV (the odd tail exercises rederiveOffsets)
 *   2. mux it into an MP4 (video container path)
 *   3. import the MP4 through importMedia -> session folder with chunk_*.wav
 *   4. assert: chunk count, byte-exact durations, offsets, monotonic global assembly
 *
 * Run: node tools/test-import.js
 * Exits 0 on success, 1 on failure. Skips with code 0 if ffmpeg is unavailable.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const repo = path.join(__dirname, '..');
const ffmpeg = require('../src/main/ffmpeg');
const { importMedia, rederiveOffsets } = require('../src/main/importer');
const { WavWriter } = require('../src/main/wav');
const { rebuildTranscript } = require('../src/main/assemble');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function synthWav(out, seconds, sampleRate = 48000) {
  const w = new WavWriter(out, { sampleRate, channels: 1, bitsPerSample: 16 }).open();
  const half = Buffer.alloc(sampleRate); // 0.5 s of non-silence-ish PCM
  for (let i = 0; i < half.length; i += 2) {
    half.writeInt16LE(Math.round(8000 * Math.sin(i / 20)), i);
  }
  let remaining = seconds;
  while (remaining >= 0.5) { w.write(half); remaining -= 0.5; }
  if (remaining > 0) {
    // exact odd tail (e.g. 0.3 s) so offsets/durations are non-round
    const tail = Buffer.alloc(Math.round(remaining * sampleRate * 2));
    for (let i = 0; i < tail.length; i += 2) {
      tail.writeInt16LE(Math.round(8000 * Math.sin(i / 20)), i);
    }
    w.write(tail);
  }
  w.close();
  return out;
}

async function main() {
  const ff = ffmpeg.findFfmpeg(repo);
  if (!ff) { console.error('ffmpeg not found — test cannot run'); process.exit(1); }
  console.log('ffmpeg:', ff);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-import-'));
  const wav = synthWav(path.join(tmp, 'tone.wav'), 7.3);

  // video container path: mux wav -> mp4
  const mp4 = path.join(tmp, 'tone.mp4');
  const { spawnSync } = require('child_process');
  const mux = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-i', wav, '-c:a', 'aac', '-y', mp4], { encoding: 'utf8' });
  if (mux.status !== 0) { console.error('mux failed:', mux.stderr); process.exit(1); }

  // session store needs minimal session shape; build by hand (no electron deps here)
  const session = {
    version: 1,
    id: 'test',
    name: 'import-test',
    folder: path.join(tmp, 'session'),
    recording: { sampleRate: 48000, channels: 1, chunkSec: 5, durationSec: 0, sources: [] },
    model: { name: 'small.en', language: 'en', device: 'cpu', vad: true },
    chunks: [],
    transcript: { language: null, fullText: '', words: [], segments: [] },
    exports: [],
  };
  fs.mkdirSync(session.folder, { recursive: true });
  require('../src/main/session').ensureDirs(session.folder);

  console.log('\nimporting wav (lossless, exact)…');
  const rWav = await importMedia({
    ffmpegPath: ff, session, mediaPath: wav, chunkSec: 5, onPersist: () => {}, onProgress: () => {},
  });
  check('wav import ok', rWav.ok, rWav.error);
  check('wav duration exact 7.3s', Math.abs(session.recording.durationSec - 7.3) < 0.005,
    `got ${session.recording.durationSec}`);
  check('wav chunk 0 byte-exact 5.000s', Math.abs(session.chunks[0].durationSec - 5) < 0.005,
    `got ${session.chunks[0].durationSec}`);
  check('wav tail chunk ~2.3s', Math.abs(session.chunks[1].durationSec - 2.3) < 0.005,
    `got ${session.chunks[1].durationSec}`);
  const wavOffsetsOk = Math.abs(session.chunks[1].offsetSec - session.chunks[0].durationSec) < 0.005;
  check('wav offsets rederived', wavOffsetsOk, `chunk1 offset ${session.chunks[1].offsetSec}`);

  // WAV import wrote chunks into the same session folder first; clear them so the
  // mp4 import starts from a clean chunk list (each import = one fresh session in prod).
  session.chunks = [];

  console.log('\nimporting mp4 through the real importer…');
  const r = await importMedia({
    ffmpegPath: ff,
    session,
    mediaPath: mp4,
    chunkSec: 5,
    onPersist: () => {},
    onProgress: () => {},
  });
  check('import ok', r.ok, r.error);

  const dur = session.recording.durationSec;
  check('duration ~7.3s (newer ffmpeg trims aac priming exactly)', Math.abs(dur - 7.3) < 0.05, `got ${dur}`);
  check('two chunks for 7.3s @ chunkSec=5', session.chunks.length === 2, `got ${session.chunks.length}`);

  // byte-exactness: chunk 0 must be exactly 5.000 s of PCM
  check('chunk 0 is byte-exact 5.000s', Math.abs(session.chunks[0].durationSec - 5) < 0.005,
    `got ${session.chunks[0].durationSec}`);
  const total = session.chunks.reduce((n, c) => n + c.durationSec, 0);
  check('chunk durations sum to file duration', Math.abs(total - dur) < 0.01, `${total} vs ${dur}`);

  check('offset 0 = 0', session.chunks[0].offsetSec === 0, `got ${session.chunks[0].offsetSec}`);
  check('offset 1 = chunk-0 duration', Math.abs(session.chunks[1].offsetSec - session.chunks[0].durationSec) < 0.005,
    `got ${session.chunks[1].offsetSec}`);

  // offsets must be re-derivable idempotently
  rederiveOffsets(session, 5, 48000);
  check('rederiveOffsets idempotent', Math.abs(session.chunks[1].offsetSec - session.chunks[0].durationSec) < 0.005);

  // assemble path works on imported chunks (no words, but must not throw and must stay monotonic)
  const tx = rebuildTranscript(session);
  check('rebuildTranscript runs on empty import', tx.words.length === 0 && tx.fullText === '');

  // session.json sanity: recording.sampleRate propagated
  check('sampleRate recorded as 48000', session.recording.sampleRate === 48000);

  // audio files exist and have valid RIFF headers
  for (const c of session.chunks) {
    const p = path.join(session.folder, c.audioFile);
    check(`chunk ${c.index} wav exists`, fs.existsSync(p));
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd);
    check(`chunk ${c.index} is RIFF`, b.toString('ascii') === 'RIFF');
  }

  console.log(`\n${failures ? 'FAILED' : 'ALL PASSED'} (${failures} failures)`);
  console.log('session at:', session.folder);
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
