'use strict';
/**
 * Build a real, transcribable demo session on disk so the UI can be inspected with actual
 * content (multiple chunks + margin timecodes).
 *
 *   node tools/make-demo-session.js [outParent] [repeats] [chunkSec] [model] [--audio=x.wav] [--diarized]
 *
 *   --audio=<wav>  use this PCM16 WAV instead of whisper.cpp's jfk.wav sample
 *   --diarized     add speaker turns: the real diarizer when native/bin/diarizer + model are
 *                  present, else alternating 6 s placeholder turns (engine "demo")
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readHeader, makeHeader } = require('../src/main/wav');
const { Recorder } = require('../src/main/recorder');
const { Pipeline } = require('../src/main/pipeline');
const { Engine } = require('../src/main/whisper');
const store = require('../src/main/session');
const { rebuildTranscript } = require('../src/main/assemble');
const diarizer = require('../src/main/diarizer');
const { buildBlock } = require('../src/main/diarize-join');

const REPO = path.join(__dirname, '..');
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const flag = (name) => flags.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagValue = (name) => (flag(name) || '').split('=').slice(1).join('=') || null;

async function addDiarization(session) {
  const opts = {
    session, repoRoot: REPO,
    binDir: path.join(REPO, 'native', 'bin'),
    modelDir: path.join(REPO, 'native', 'models'),
    ffmpegPath: require('../src/main/ffmpeg').findFfmpeg(REPO, path.join(REPO, 'native', 'bin')),
  };
  if (diarizer.status(opts).available) {
    const r = await diarizer.runDiarize(opts);
    if (!r.ok) throw new Error(`diarizer: ${r.error}`);
    session.diarization = buildBlock(r);
    console.log(`diarized (real): ${session.diarization.speakers} speakers in ${r.ms} ms`);
    return;
  }
  const dur = session.recording.durationSec;
  const turns = [];
  for (let t = 0, k = 0; t < dur; t += 6, k++) turns.push({ start: t, end: Math.min(dur, t + 5.6), speaker: k % 2 });
  session.diarization = buildBlock({ turns, engine: 'demo', model: 'placeholder', audioSec: dur });
  console.log('diarized (placeholder turns — no diarizer installed)');
}

async function main() {
  const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const outParent = pos[0] || path.join(os.homedir(), 'susurro-dev-sessions');
  const repeats = Number(pos[1] || 3);
  const chunkSec = Number(pos[2] || 15);
  const modelId = pos[3] || 'small.en';

  const src = flagValue('audio') || path.join(REPO, 'native', 'src', 'whisper.cpp', 'samples', 'jfk.wav');
  const hdr = readHeader(src);
  const one = fs.readFileSync(src).subarray(44);
  const pcm = Buffer.concat(Array.from({ length: repeats }, () => one));
  const seconds = pcm.length / ((hdr.channels * hdr.bitsPerSample) / 8) / hdr.sampleRate;

  fs.mkdirSync(outParent, { recursive: true });
  const session = store.createSession({
    parentDir: outParent,
    name: 'demo-session',
    settings: { model: modelId, language: 'en', vad: true },
    gpu: null,
    model: { name: modelId, device: 'auto' },
    chunkSec,
    sources: [{ id: 'src1', kind: 'mic', label: 'Demo Source', gain: 1, muted: false }],
  });
  session.recording.startedAt = new Date().toISOString();

  const rec = new Recorder({ session, chunkSec, sampleRate: hdr.sampleRate, onChunkClosed: () => {} });
  rec.start();
  for (let i = 0; i < pcm.length; i += 8192) rec.push(pcm.subarray(i, i + 8192));
  rec.stop();
  session.recording.stoppedAt = new Date().toISOString();
  session.recording.durationSec = Number(rec.recordedSeconds.toFixed(2));

  console.log(`audio: ${seconds.toFixed(1)}s in ${session.chunks.length} chunks of ${chunkSec}s`);

  const engine = new Engine({
    binDir: path.join(__dirname, '..', 'native', 'bin'),
    modelDir: path.join(__dirname, '..', 'native', 'models'),
  });
  const pipeline = new Pipeline({
    engine,
    getSession: () => session,
    onPersist: () => store.writeSession(session.folder, session),
    emit: () => {},
    gpu: null,
    device: 'auto',
  });
  pipeline.enqueueAllOutstanding();
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pipeline.remaining === 0 && pipeline.running === 0) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > 900000) { clearInterval(iv); reject(new Error('timeout')); }
    }, 200);
  });

  rebuildTranscript(session);
  if (flag('diarized')) await addDiarization(session);
  store.writeSession(session.folder, session);

  console.log(`words: ${session.transcript.words.length}  segments: ${session.transcript.segments.length}`);
  console.log(`FOLDER=${session.folder}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
