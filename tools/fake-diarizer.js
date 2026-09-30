'use strict';
/**
 * Test double for `nemo-speech diarize <wav> --model <gguf> --format json --quiet`.
 * Spawned as `node fake-diarizer.js diarize ...` (ELECTRON_RUN_AS_NODE=1 under Electron).
 *
 *   FAKE_DIAR_MODE  ok (default) | fail | badjson | hang
 *   FAKE_DIAR_ARGS  optional path: {args, threads, sampleRate of the input WAV} as JSON
 *
 * The `ok` output mirrors the real CLI (app/diarize.cpp render_result): 1-based integer
 * speakers, unsorted-safe, plus one degenerate segment the parser must drop.
 */
const fs = require('fs');

const args = process.argv.slice(2);
if (process.env.FAKE_DIAR_ARGS) {
  let sampleRate = null;
  try { const h = Buffer.alloc(28); const fd = fs.openSync(args[1], 'r'); fs.readSync(fd, h, 0, 28, 0); fs.closeSync(fd); sampleRate = h.readUInt32LE(24); } catch { /* no input */ }
  fs.writeFileSync(process.env.FAKE_DIAR_ARGS, JSON.stringify({ args, threads: process.env.NEMO_SPEECH_CPU_THREADS || null, sampleRate }));
}

const mode = process.env.FAKE_DIAR_MODE || 'ok';
const wav = args[1];

if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'fail') {
  process.stderr.write('[nemo-speech] diarize session started\n');
  process.stderr.write('nemo-speech diarize: sortformer: model file is corrupt\n');
  process.exit(1);
} else if (mode === 'badjson') {
  process.stdout.write('{"file": "x", "segments": [');
  process.exit(0);
} else {
  if (!wav || !fs.existsSync(wav)) {
    process.stderr.write(`nemo-speech diarize: cannot open ${wav}\n`);
    process.exit(1);
  }
  const doc = {
    file: wav,
    segments: [
      { start: 2.3, end: 4.0, speaker: 1 },
      { start: 0.5, end: 2.1, speaker: 2 },
      { start: 3.0, end: 3.0, speaker: 3 },   // zero length: dropped by the parser
      { start: 4.2, end: 5.9, speaker: 2 },
    ],
  };
  process.stdout.write(JSON.stringify(doc, null, 2));
}
