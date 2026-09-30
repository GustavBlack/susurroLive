'use strict';
/**
 * Parakeet ASR engine (NVIDIA NeMo TDT 0.6b v3) via the sherpa-onnx offline CLI.
 *
 * Sidecar: `sherpa-onnx-offline.exe` runs one WAV -> one JSON result on stdout, exactly the
 * whisper-cli.exe contract (stateless per invocation, crash isolation for free). The exe and
 * its onnxruntime DLLs live in their OWN folder (bin/sherpa/), the model files in a sherpa/
 * subdirectory of the model dir:
 *
 *   bin/sherpa/sherpa-onnx-offline.exe (+ onnxruntime.dll, onnxruntime_providers_shared.dll)
 *   models/sherpa/encoder.int8.onnx, decoder.int8.onnx, joiner.int8.onnx, tokens.txt
 *
 * sherpa-onnx emits BPE SUBWORD tokens (" Well", "'", "t") with per-token timestamps and
 * durations; words are reconstructed by joining subwords on leading whitespace, mirroring the
 * word-reconstruction semantics of whisper.js. Timestamps are CHUNK-LOCAL seconds — the same
 * contract whisper follows; assemble.js applies the offset exactly once at aggregation.
 *
 * Availability is DEMO-pattern: missing exe/model means status().available=false with a reason,
 * and the pipeline falls back (the selector routes to whisper instead — Parakeet never demos).
 *
 * Contract: transcribe() resolves {engine:'parakeet', words, text, language} or throws with a
 * message safe to show on a chunk's error state. Nothing here throws into construction.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readHeader } = require('../wav');

const SUBDIR = 'sherpa';
const EXE = 'sherpa-onnx-offline.exe';
const FILES = {
  encoder: 'encoder.int8.onnx',
  decoder: 'decoder.int8.onnx',
  joiner: 'joiner.int8.onnx',
  tokens: 'tokens.txt',
};

/** Candidate exe locations, first existing wins (mirrors diarizer.js searchPaths). */
function searchPaths(repoRoot, binDir, provisionDir) {
  return [
    binDir ? path.join(binDir, SUBDIR, EXE) : '',                // packaged: resources/bin/sherpa
    provisionDir ? path.join(provisionDir, SUBDIR, EXE) : '',    // in-app provisioned (userData)
    repoRoot ? path.join(repoRoot, 'native', 'bin', SUBDIR, EXE) : '', // dev repo layout
    process.env.SUSURRO_SHERPA || '',                            // explicit override
  ];
}

let cachedExe = '';
function findBinary(repoRoot, binDir, provisionDir) {
  if (cachedExe && fs.existsSync(cachedExe)) return cachedExe;
  for (const p of searchPaths(repoRoot, binDir, provisionDir)) {
    if (p && fs.existsSync(p)) { cachedExe = p; return p; }
  }
  return '';
}

/** The four model files, or null if any is missing. Checks both layouts independently. */
function findModel(modelDir, provisionDir) {
  const dirs = [];
  try { if (modelDir) dirs.push(path.join(modelDir, SUBDIR)); } catch { /* null modelDir */ }
  try { if (provisionDir) dirs.push(path.join(provisionDir, SUBDIR, 'models')); } catch { /* null */ }
  for (const dir of dirs) {
    try {
      const files = {};
      let complete = true;
      for (const [key, name] of Object.entries(FILES)) {
        const p = path.join(dir, name);
        if (!fs.existsSync(p)) { complete = false; break; }
        files[key] = p;
      }
      if (complete) return { dir, ...files };
    } catch { /* try next */ }
  }
  return null;
}

const missingExe = (binDir) => `${EXE} not found in ${path.join(binDir || '', SUBDIR)} - parakeet unavailable.`;
const missingModel = (modelDir) => `incomplete parakeet model in ${path.join(modelDir || '', SUBDIR)} (needs encoder/decoder/joiner int8 onnx + tokens.txt) - parakeet unavailable.`;

/** For the Settings diagnostics line and the engine picker's availability. */
function status({ repoRoot, binDir, modelDir, provisionDir }) {
  const binary = findBinary(repoRoot, binDir, provisionDir);
  const model = findModel(modelDir, provisionDir);
  return {
    available: !!binary && !!model,
    binary: binary || null,
    model: model ? model.dir : null,
    reason: !binary ? missingExe(binDir) : !model ? missingModel(modelDir) : null,
  };
}

/** BPE subwords carry a leading space where a new word starts. */
function startsNewWord(token) {
  return /^\s/.test(token) || token.startsWith('▁');
}

/**
 * Reconstruct WORDS from BPE subword tokens.
 *   tokens      [" Well", ",", " I", " don", "'", "t", ...]
 *   timestamps  per-token start, seconds, chunk-local
 *   durations   per-token duration, seconds
 * A token starting with whitespace opens a new word; others extend the current one. The word's
 * t = first subword start; d = max(t+d of subwords) - t (zero-duration subwords are real:
 * whisper.js proved dropping them mangles contractions). Punctuation extends the current span.
 */
function joinWords(tokens, timestamps, durations) {
  const words = [];
  const n = Math.min(tokens.length, timestamps.length, durations.length);
  for (let i = 0; i < n; i++) {
    const raw = String(tokens[i] ?? '').replace(/^▁/u, ' ');
    const t = Math.max(0, Number(timestamps[i]) || 0);
    const d = Math.max(0, Number(durations[i]) || 0);
    const body = raw.replace(/\s+/gu, ' ').trim();
    if (!body) continue;

    const opensWord = /^\s/.test(raw);
    const prev = words[words.length - 1];
    if (opensWord || !prev) {
      words.push({ t, d, w: body });
    } else {
      const end = Math.max(prev.t + prev.d, t + d);
      prev.t = Math.min(prev.t, t);
      prev.d = end - prev.t;
      prev.w += body;
    }
  }
  return words;
}

/** Parse the JSON sherpa-onnx-offline prints on stdout. */
function parseSherpaJson(text) {
  let doc;
  try {
    // Some builds print logs before/after the JSON; take the outermost object.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object');
    doc = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('sherpa-onnx produced malformed JSON; the audio can be retried');
  }
  if (typeof doc?.text !== 'string') {
    throw new Error('sherpa-onnx JSON has no text field; the audio can be retried');
  }
  return {
    text: doc.text,
    tokens: Array.isArray(doc.tokens) ? doc.tokens.map(String) : [],
    timestamps: Array.isArray(doc.timestamps) ? doc.timestamps.map(Number) : [],
    durations: Array.isArray(doc.durations) ? doc.durations.map(Number) : [],
  };
}

class ParakeetEngine {
  constructor({ repoRoot, binDir, modelDir, ffmpegPath, provisionDir }) {
    this.repoRoot = repoRoot;
    this.binDir = binDir;
    this.modelDir = modelDir;
    this.provisionDir = provisionDir || '';
    this.ffmpegPath = ffmpegPath || '';
  }

  status() {
    return status({ repoRoot: this.repoRoot, binDir: this.binDir, modelDir: this.modelDir, provisionDir: this.provisionDir });
  }

  /**
   * Transcribe one audio file (chunk). 16 kHz mono feed via ffmpeg when available; sherpa-onnx
   * also accepts 48 kHz wavs (it resamples internally), ffmpeg just makes timing consistent
   * with diarization and trims memory.
   * @returns {Promise<{engine:'parakeet', words:Array, text:string, language:string|null}>}
   */
  async transcribe(audioPath, { device = 'auto', timeoutMs = 15 * 60 * 1000 } = {}) {
    const st = this.status();
    if (!st.available) throw new Error(st.reason);

    // ffmpeg downsample to 16 kHz mono; fall back to the original file when ffmpeg is absent.
    let input = audioPath;
    let temp = '';
    if (this.ffmpegPath && fs.existsSync(this.ffmpegPath)) {
      try {
        temp = path.join(path.dirname(audioPath), `.parakeet16k_${path.basename(audioPath, '.wav')}.wav`);
        const ok = await this._downsample(this.ffmpegPath, audioPath, temp);
        if (ok) input = temp;
      } catch { /* fall back to the original file */ }
    }

    try {
      const m = st.model && findModel(this.modelDir, this.provisionDir);
      if (!m) throw new Error(missingModel(this.modelDir));
      // sherpa-onnx CLI wants --x=y form (space-separated pairs are rejected by parse-options)
      const args = [
        `--encoder=${m.encoder}`,
        `--decoder=${m.decoder}`,
        `--joiner=${m.joiner}`,
        `--tokens=${m.tokens}`,
        '--model-type=nemo_transducer',
        '--decoding-method=greedy_search',
        input,
      ];
      const stdout = await this._run(args, timeoutMs);
      const parsed = parseSherpaJson(stdout);
      const words = joinWords(parsed.tokens, parsed.timestamps, parsed.durations)
        .map((w) => ({ t: Number(w.t.toFixed(3)), d: Number(w.d.toFixed(3)), w: w.w }));
      return {
        engine: 'parakeet',
        words,
        text: words.length ? words.map((x) => x.w).join(' ') : parsed.text,
        language: null, // parakeet v3 is multilingual without a language id output
      };
    } finally {
      if (temp) { try { fs.unlinkSync(temp); } catch { /* keep going */ } }
    }
  }

  _downsample(ffmpegPath, src, dst) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
          '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dst,
        ], { windowsHide: true, stdio: 'ignore' });
      } catch { resolve(false); return; }
      const to = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(false); }, 60 * 1000);
      child.on('error', () => { clearTimeout(to); resolve(false); });
      child.on('close', (code) => { clearTimeout(to); resolve(code === 0 && fs.existsSync(dst)); });
    });
  }

  _run(args, timeoutMs) {
    const st = this.status();
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(st.binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        reject(new Error(`cannot start sherpa-onnx: ${e.message}`));
        return;
      }
      const out = [];
      let stderr = '';
      let settled = false;
      const to = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        reject(new Error(`parakeet timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
      child.on('error', (e) => {
        if (settled) return;
        settled = true; clearTimeout(to);
        reject(new Error(`cannot start sherpa-onnx: ${e.message}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true; clearTimeout(to);
        const stdout = Buffer.concat(out).toString('utf8');
        if (code === 0) resolve(stdout);
        else reject(new Error(`sherpa-onnx exited ${code}: ${stderr.split(/\r?\n/).slice(-4).join(' | ')}`));
      });
    });
  }
}

module.exports = {
  ParakeetEngine,
  status,
  findBinary,
  findModel,
  parseSherpaJson,
  joinWords,
  startsNewWord,
  FILES,
  SUBDIR,
};
