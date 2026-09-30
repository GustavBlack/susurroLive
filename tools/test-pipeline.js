'use strict';
/**
 * Pipeline integration test (no GUI, no Electron).
 * Feeds a real WAV through the Recorder -> chunker -> Pipeline -> whisper -> global timeline.
 *
 *   node tools/test-pipeline.js
 *
 * Verifies the app's core promise: chunk-while-recording with a correct session timeline.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readHeader } = require('../src/main/wav');
const { Recorder } = require('../src/main/recorder');
const { Pipeline } = require('../src/main/pipeline');
const { Engine } = require('../src/main/whisper');
const store = require('../src/main/session');
const { rebuildTranscript } = require('../src/main/assemble');

const CHUNK_SEC = 5;

async function main() {
  const binDir = path.join(__dirname, '..', 'native', 'bin');
  const modelDir = path.join(__dirname, '..', 'native', 'models');
  const srcWav = path.join(__dirname, '..', 'native', 'src', 'whisper.cpp', 'samples', 'jfk.wav');

  const engine = new Engine({ binDir, modelDir });
  const st = engine.status();
  console.log(`engine available : ${st.available}  (${st.available ? 'real' : 'DEMO'})`);
  if (!st.available) console.log('  reason:', st.reason);

  // ---- fresh session in a temp dir ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-test-'));
  const session = store.createSession({
    parentDir: root,
    name: 'pipeline-test',
    settings: { model: 'small.en', language: 'en', vad: true },
    gpu: null,
    model: { name: 'small.en', device: 'cpu' },
    chunkSec: CHUNK_SEC,
    sources: [{ id: 'src1', kind: 'mic', label: 'test', gain: 1, muted: false }],
  });
  session.recording.startedAt = new Date().toISOString();
  console.log(`session folder   : ${session.folder}`);

  // ---- feed a real WAV through the chunker ----
  const hdr = readHeader(srcWav);
  const pcm = fs.readFileSync(srcWav).subarray(44);
  const srcSeconds = pcm.length / ((hdr.channels * hdr.bitsPerSample) / 8) / hdr.sampleRate;

  const closed = [];
  const rec = new Recorder({
    session,
    chunkSec: CHUNK_SEC,
    sampleRate: hdr.sampleRate,
    onChunkClosed: (i) => closed.push(i),
  });
  rec.start();
  for (let i = 0; i < pcm.length; i += 8192) rec.push(pcm.subarray(i, i + 8192));
  rec.stop();

  session.recording.stoppedAt = new Date().toISOString();
  session.recording.durationSec = Number(rec.recordedSeconds.toFixed(2));

  console.log(`source audio     : ${srcSeconds.toFixed(2)}s  @ ${hdr.sampleRate}Hz`);
  console.log(`chunks closed    : ${closed.length} -> ${session.chunks.map((c) => c.durationSec.toFixed(2) + 's').join(', ')}`);

  // exercise the playback-side concatenation as well
  const { concatWavs } = require('../src/main/wav');
  const full = concatWavs(
    session.chunks.map((c) => path.join(session.folder, c.audioFile)),
    path.join(session.folder, 'audio', 'full.wav'),
  );
  console.log(`full.wav         : ${full ? full.seconds.toFixed(2) + 's' : 'FAILED'}`);

  // ---- run the real pipeline ----
  const pipeline = new Pipeline({
    engine,
    getSession: () => session,
    onPersist: () => store.writeSession(session.folder, session),
    emit: () => {},
    gpu: null,
    device: 'cpu',
  });
  const t0 = Date.now();
  pipeline.enqueueAllOutstanding();

  await new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (pipeline.remaining === 0 && pipeline.running === 0) { clearInterval(iv); resolve(); }
      else if (Date.now() - started > 300000) { clearInterval(iv); reject(new Error('pipeline timeout')); }
    }, 150);
  });
  const elapsed = Date.now() - t0;

  rebuildTranscript(session);
  store.writeSession(session.folder, session);

  // ---- verify ----
  const chunks = session.chunks;
  const tr = session.transcript;
  const statuses = chunks.map((c) => c.status);
  const allDone = statuses.every((s) => s === 'done');
  const times = tr.words.map((w) => w.t);
  const monotonic = times.every((t, i) => i === 0 || t >= times[i - 1]);
  const first = times[0] ?? 0;
  const lastEnd = tr.words.length
    ? tr.words[tr.words.length - 1].t + tr.words[tr.words.length - 1].d
    : 0;
  // jfk.wav starts speaking almost immediately, so the first word sits near t=0.
  const startsAtBeginning = first >= 0 && first < 1.5;
  // The offset MUST be applied: words have to exist past the first chunk boundary,
  // meaning they came from a later chunk and were shifted into absolute session time.
  const wordsBeyondFirstChunk = tr.words.filter((w) => w.t >= CHUNK_SEC).length;
  const offsetApplied = wordsBeyondFirstChunk > 0;
  // Nothing may land outside the recording (guards whisper timestamp drift).
  const saneTimeline = tr.words.every((w) => w.t + w.d <= session.recording.durationSec + 1);
  // The sub-second trailing chunk must be SKIPPED, not hallucinated into the timeline.
  const tailChunk = chunks[chunks.length - 1];
  const tailSkipped = tailChunk.durationSec < 1.0
    ? tailChunk.engine === 'skipped' && (tailChunk.words || []).length === 0
    : true;

  const report = {
    chunks: chunks.length,
    statuses: statuses.join(','),
    allDone,
    words: tr.words.length,
    segments: tr.segments.length,
    firstWordT: first,
    lastWordEnd: Number(lastEnd.toFixed(2)),
    recordingDuration: session.recording.durationSec,
    monotonic,
    startsAtBeginning,
    offsetApplied,
    wordsBeyondFirstChunk,
    saneTimeline,
    tailChunkSec: tailChunk.durationSec,
    tailSkipped,
    engines: chunks.map((c) => c.engine || '-').join(','),
    chunkFilesExist: chunks.every((c) => fs.existsSync(path.join(session.folder, c.audioFile))),
    sidecars: chunks.filter((c) => c.transcriptFile).length,
    transcribedChunks: chunks.filter((c) => c.engine && c.engine !== 'skipped').length,
    fullWav: fs.existsSync(path.join(session.folder, 'audio', 'full.wav')),
    elapsedMs: elapsed,
  };
  console.log('\n--- report ---');
  console.log(JSON.stringify(report, null, 2));
  console.log('\n--- transcript preview ---');
  console.log(tr.fullText.slice(0, 240));

  const pass = report.chunks >= 3 && report.allDone && report.words > 0 &&
    report.monotonic && report.startsAtBeginning && report.offsetApplied &&
    report.saneTimeline && report.tailSkipped && report.chunkFilesExist &&
    report.sidecars === report.transcribedChunks && report.fullWav;

  console.log('\nRESULT:', pass ? 'PASS' : 'FAIL');
  if (!pass) console.log('session kept for inspection:', session.folder);
  else fs.rmSync(root, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
