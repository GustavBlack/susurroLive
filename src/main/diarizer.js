'use strict';
/**
 * Speaker diarization sidecar: NVIDIA NeMo-Speech.cpp `nemo-speech diarize`, run offline over
 * the session's full audio after transcription. Produces speaker TURNS only; the word join
 * lives in diarize-join.js.
 *
 * The exe lives in its OWN folder (resources/bin/diarizer/): it ships ggml*.dll with the same
 * names as whisper.cpp's but from a different ggml revision, and Windows loads DLLs from the
 * exe's folder first. The parent bin/ is prepended to PATH so a CUDA build can borrow the
 * CUDA runtime DLLs already shipped for whisper.
 *
 * Contract: nothing here throws into the caller. Every entry point returns {ok:false, error}.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { concatWavs, readHeader, HEADER_BYTES } = require('./wav');

const SUBDIR = 'diarizer';
const EXE = 'nemo-speech.exe';
const MODEL_RE = /^nemotron-3-diarization.*\.gguf$/i;

/** Candidate locations, first existing wins (mirrors ffmpeg.js). */
function searchPaths(repoRoot, binDir) {
  return [
    binDir ? path.join(binDir, SUBDIR, EXE) : '',                // packaged: resources/bin/diarizer
    repoRoot ? path.join(repoRoot, 'native', 'bin', SUBDIR, EXE) : '', // dev repo layout
    process.env.SUSURRO_DIARIZER || '',                          // explicit override
  ];
}

// Only a hit is cached: dropping the exe in later must not require an app restart.
let cached = '';
function findDiarizer(repoRoot, binDir) {
  if (cached && fs.existsSync(cached)) return cached;
  for (const p of searchPaths(repoRoot, binDir)) {
    if (p && fs.existsSync(p)) { cached = p; return p; }
  }
  try {
    const out = execFileSync('where', ['nemo-speech'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) { cached = first; return first; }
  } catch { /* not on PATH */ }
  return '';
}

/** The bundled diarization model (q8_0 preferred), or null. */
function findDiarModel(modelDir) {
  try {
    const files = fs.readdirSync(modelDir).filter((f) => MODEL_RE.test(f));
    files.sort((a, b) => Number(/q8_0/i.test(b)) - Number(/q8_0/i.test(a)) || a.localeCompare(b));
    if (!files.length) return null;
    const file = files[0];
    return { file, path: path.join(modelDir, file), id: file.replace(/\.gguf$/i, '') };
  } catch {
    return null;
  }
}

const missingExe = (binDir) => `${EXE} not found in ${path.join(binDir || '', SUBDIR)} - speaker diarization unavailable.`;
const missingModel = (modelDir) => `no nemotron-3-diarization*.gguf in ${modelDir} - speaker diarization unavailable.`;

/** For the Settings diagnostics line and the Diarize button's availability. */
function status({ repoRoot, binDir, modelDir }) {
  const binary = findDiarizer(repoRoot, binDir);
  const model = findDiarModel(modelDir);
  return {
    available: !!binary && !!model,
    binary: binary || null,
    model: model ? model.id : null,
    reason: !binary ? missingExe(binDir) : !model ? missingModel(modelDir) : null,
  };
}

/**
 * Make sure audio/full.wav exists and matches the chunks (it is the global timeline:
 * chunks concatenated in index order). Built with the same concatWavs() as session:buildFull.
 * Read-only on `session`. Returns {path, seconds}.
 */
function ensureFullWav(session) {
  const chunks = (session.chunks || []).slice()
    .sort((a, b) => a.index - b.index)
    .map((c) => path.join(session.folder, c.audioFile))
    .filter((p) => fs.existsSync(p));
  if (!chunks.length) throw new Error('this session has no audio yet');

  const out = path.join(session.folder, 'audio', 'full.wav');
  const expected = HEADER_BYTES + chunks.reduce((n, p) => n + fs.statSync(p).size - HEADER_BYTES, 0);
  if (!fs.existsSync(out) || fs.statSync(out).size !== expected) concatWavs(chunks, out);

  const h = readHeader(out);
  const bytesPerSec = h.sampleRate * h.channels * (h.bitsPerSample / 8);
  return { path: out, seconds: (fs.statSync(out).size - HEADER_BYTES) / bytesPerSec };
}

/**
 * Downsample to 16 kHz (the model rate) with the bundled ffmpeg. The CLI would resample itself,
 * but it loads the whole file as float32 first: an hour at 48 kHz peaked at 1.85 GB RAM, at
 * 16 kHz 1.18 GB, with the same speakers. Resolves true on success, false otherwise.
 */
function downsample(ffmpegPath, src, dst) {
  return new Promise((resolve) => {
    if (!ffmpegPath) { resolve(false); return; }
    let child;
    try {
      child = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dst,
      ], { windowsHide: true, stdio: 'ignore' });
    } catch { resolve(false); return; }
    const to = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(false); }, 5 * 60 * 1000);
    child.on('error', () => { clearTimeout(to); resolve(false); });
    child.on('close', (code) => { clearTimeout(to); resolve(code === 0 && fs.existsSync(dst)); });
  });
}

/**
 * Parse `nemo-speech diarize --format json`:
 *   { "file": "...", "segments": [ { "start": 0.0, "end": 1.2, "speaker": 1 }, ... ] }
 * Speakers are 1-based integers. Returns raw turns (normalizeTurns relabels them).
 */
function parseDiarJson(text) {
  let doc;
  try {
    doc = JSON.parse(String(text || '').trim());
  } catch {
    throw new Error('diarizer produced malformed JSON');
  }
  if (!Array.isArray(doc?.segments)) throw new Error('diarizer JSON has no segments array');
  return doc.segments
    .map((s) => ({ start: Number(s.start), end: Number(s.end), speaker: s.speaker }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
}

/** Half the logical cores, clamped to 4..16. */
function cpuThreads() {
  return Math.max(4, Math.min(16, Math.floor((os.cpus().length || 8) / 2)));
}

let versionCache = null;
function engineVersion(exe) {
  if (versionCache && versionCache.exe === exe) return versionCache.value;
  let value = 'nemo-speech';
  try {
    value = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      .split(/\r?\n/)[0].trim() || value;
  } catch { /* keep the generic name */ }
  versionCache = { exe, value };
  return value;
}

/** Spawn and collect stdout. Resolves {stdout} or rejects with the stderr tail. */
function run(exe, args, { env, timeoutMs, onSpawned }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new Error(`cannot start diarizer: ${e.message}`));
      return;
    }
    if (onSpawned) onSpawned(child);
    const out = [];
    let stderr = '';
    let settled = false;
    const to = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`diarizer timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true; clearTimeout(to);
      reject(new Error(`cannot start diarizer: ${e.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(to);
      if (code === 0) resolve({ stdout: Buffer.concat(out).toString('utf8') });
      else {
        const tail = stderr.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-3).join(' | ');
        reject(new Error(`diarizer exited ${code}${tail ? `: ${tail}` : ''}`));
      }
    });
  });
}

/**
 * Diarize a session's audio. Never throws.
 * @param {object} o
 * @param {object} o.session   read-only; needs folder + chunks
 * @param {string} o.repoRoot
 * @param {string} o.binDir
 * @param {string} o.modelDir
 * @param {string} [o.ffmpegPath]  when given, the audio is downsampled to 16 kHz first (less RAM)
 * @param {number} [o.timeoutMs]  default: 10 min + 1x audio length
 * @param {(child) => void} [o.onSpawned]  lets the caller kill the run (app quit)
 * @param {{exe:string, argsPrefix?:string[], env?:object}} [o.cmd]  test override
 * @returns {Promise<{ok:true, turns, engine, model, audioSec, ms} | {ok:false, error:string}>}
 */
async function runDiarize({ session, repoRoot, binDir, modelDir, ffmpegPath, timeoutMs, onSpawned, cmd } = {}) {
  const started = Date.now();
  let temp = null;
  try {
    if (!session?.folder) return { ok: false, error: 'no session' };
    const exe = cmd?.exe || findDiarizer(repoRoot, binDir);
    if (!exe) return { ok: false, error: missingExe(binDir) };
    const model = findDiarModel(modelDir);
    if (!model) return { ok: false, error: missingModel(modelDir) };

    const audio = ensureFullWav(session);
    let input = audio.path;
    const small = path.join(session.folder, 'temp', 'diar_16k.wav');
    fs.mkdirSync(path.dirname(small), { recursive: true });
    if (await downsample(ffmpegPath, audio.path, small)) { input = small; temp = small; }

    const args = [
      ...(cmd?.argsPrefix || []),
      'diarize', input,
      '--model', model.path,
      '--format', 'json',
      '--quiet',
    ];
    // Windows names it `Path`; reuse the existing key so the child never sees two of them.
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = [binDir, env[pathKey] || ''].filter(Boolean).join(path.delimiter);
    // Read by scripts/patches/nemo-speech-cpu-threads.patch (upstream fixes 4). Diarization only
    // runs once transcription is idle, so half the logical cores is a fair share.
    if (!env.NEMO_SPEECH_CPU_THREADS) env.NEMO_SPEECH_CPU_THREADS = String(cpuThreads());
    Object.assign(env, cmd?.env || {});
    const limit = timeoutMs || 10 * 60 * 1000 + Math.ceil(audio.seconds * 1000);

    const { stdout } = await run(exe, args, { env, timeoutMs: limit, onSpawned });
    const turns = parseDiarJson(stdout);
    return {
      ok: true,
      turns,
      engine: cmd ? 'test' : engineVersion(exe),
      model: model.id,
      audioSec: audio.seconds,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    if (temp) { try { fs.unlinkSync(temp); } catch { /* temp/ is disposable anyway */ } }
  }
}

module.exports = { findDiarizer, findDiarModel, status, ensureFullWav, parseDiarJson, runDiarize, SUBDIR, EXE };
