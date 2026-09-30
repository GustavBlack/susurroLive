'use strict';
/**
 * Transcription engine.
 *
 * Primary  : whisper.cpp `whisper-cli.exe` (CUDA or CPU), one process per chunk.
 * Fallback : a built-in DEMO generator so the full pipeline/session/playback/export UX can be
 *            exercised on a machine where the native engine or model is not yet present.
 *            Demo results are ALWAYS tagged engine:"demo" and surfaced in the UI.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SENTENCE_END = /[.!?…]["')\]]?$/;
const WORD_CAP = 2_500_000; // ~ a few days of speech; guards runaway memory

function listModels(modelDir) {
  const out = [];
  try {
    for (const f of fs.readdirSync(modelDir)) {
      if (!/^ggml-.*\.bin$/.test(f)) continue;
      const st = fs.statSync(path.join(modelDir, f));
      out.push({
        file: f,
        id: f.replace(/^ggml-/, '').replace(/\.bin$/, ''),
        bytes: st.size,
        mb: Math.round(st.size / 1e6),
      });
    }
  } catch { /* dir may not exist yet */ }
  out.sort((a, b) => a.bytes - b.bytes);
  return out;
}

/** Compare words ignoring case and punctuation. */
function normWord(w) {
  return String(w ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Scrub repetition loops after reconstructing words from the model's text fragments:
 *     "ask not what your country can do for you" repeated 9 times inside one 15s chunk.
 *
 * Zero-duration or shared timestamps are NOT evidence that text is spurious. Whisper's
 * experimental alignment can give real words (and especially subword suffixes) no duration.
 * Dropping these used to turn "I'm" into "I" and "truncated" into "uncated".
 *
 * Real speech repeats short phrases, so the loop guard is deliberately conservative:
 * it only fires on a 4+ word phrase repeated MORE THAN 4 times in a row.
 */
function cleanWhisperWords(words) {
  return collapseLoops(words);
}

/** Do two equal-length runs of words match (ignoring case/punctuation)? */
function sameGram(words, a, b, gram) {
  for (let k = 0; k < gram; k++) {
    if (normWord(words[a + k].w) !== normWord(words[b + k].w)) return false;
  }
  return true;
}

function collapseLoops(words, { minGram = 4, maxGram = 12, maxRepeat = 4 } = {}) {
  const n = words.length;
  if (n < minGram * 2) return words;

  const drop = new Uint8Array(n);
  for (let i = 0; i + minGram * 2 <= n; i++) {
    for (let gram = minGram; gram <= maxGram; gram++) {
      if (i + gram * 2 > n) break;
      // cheap prune: the phrase must actually restart at i+gram
      if (normWord(words[i].w) !== normWord(words[i + gram].w)) continue;

      let reps = 1;
      // cap purely to bound work; must exceed any plausible real repetition run so the
      // whole run is found and collapsed in one pass
      while (reps < 64 && i + (reps + 1) * gram <= n && sameGram(words, i, i + reps * gram, gram)) {
        reps++;
      }
      if (reps > maxRepeat) {
        const from = i + maxRepeat * gram;
        const to = Math.min(n, i + reps * gram);
        for (let k = from; k < to; k++) drop[k] = 1;
        i = to - 1;
        break;
      }
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (!drop[i]) out.push(words[i]);
  return out;
}

/**
 * Reassemble text BEFORE using token timing or trimming whitespace. A Whisper token may be
 * " I", "'m", " trans", "cription", or just punctuation, not a complete word. Original
 * whitespace is the word boundary; zero-duration pieces are still part of the word. Native
 * --split-on-word also keeps UTF-8 codepoints intact before JSON is decoded by Node.
 *
 * Languages without spaces retain contiguous phrases, with a combined time range, rather
 * than acquiring fabricated spaces between characters. Segment-only JSON is also accepted;
 * its words share the enclosing segment's approximate timing.
 */
function reconstructWords(items) {
  const words = [];
  let boundary = true;
  for (const it of items) {
    const raw = String(it?.text ?? '');
    const rawFrom = Number(it?.offsets?.from) / 1000;
    const rawTo = Number(it?.offsets?.to) / 1000;
    const tail = words[words.length - 1];
    const from = Number.isFinite(rawFrom) ? Math.max(0, rawFrom) : tail ? tail.t + tail.d : 0;
    const to = Number.isFinite(rawTo) ? Math.max(from, rawTo) : from;
    for (const part of raw.match(/\s+|\S+/gu) || []) {
      if (/^\s/u.test(part)) {
        boundary = true;
        continue;
      }
      const prev = words[words.length - 1];
      if (boundary || !prev) {
        words.push({ t: from, d: Math.max(0, to - from), w: part });
      } else {
        const end = Math.max(prev.t + prev.d, from, to);
        prev.t = Math.min(prev.t, from);
        prev.d = end - prev.t;
        prev.w += part;
      }
      boundary = false;
    }
  }
  return words;
}

/** Parse whisper.cpp --output-json, preserving subwords, contractions and Unicode text. */
function parseWhisperJson(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('whisper produced malformed JSON; the audio can be retried');
  }
  if (!Array.isArray(doc?.transcription)) {
    throw new Error('whisper JSON is missing its transcription array; the audio can be retried');
  }
  const words = cleanWhisperWords(reconstructWords(doc.transcription));
  return {
    words,
    text: words.map((x) => x.w).join(' '),
    language: doc?.result?.language ?? null,
  };
}

/** DEMO: fabricate plausible timed words across `durationSec`. Clearly not real speech. */
function demoTranscribe(durationSec, chunkIndex) {
  const script = [
    'Alright', 'this', 'is', 'a', 'demo', 'transcript', 'because', 'the', 'native',
    'whisper', 'engine', 'or', 'model', 'was', 'not', 'available', 'yet.', 'Everything',
    'else', 'you', 'see', 'here', 'is', 'real:', 'the', 'chunking,', 'the', 'session',
    'file,', 'the', 'timeline,', 'and', 'the', 'playback', 'sync.', 'Add', 'the',
    'whisper', 'binary', 'and', 'a', 'ggml', 'model', 'to', 'get', 'actual', 'speech.',
  ];
  const dur = Math.max(1, durationSec);
  const words = [];
  const per = Math.max(0.22, Math.min(0.5, dur / Math.max(1, script.length)));
  let t = 0.4 + (chunkIndex % 3) * 0.1;
  let i = 0;
  while (t + per < dur - 0.3 && words.length < 4000) {
    const w = script[i % script.length];
    words.push({ t: Number(t.toFixed(2)), d: Number(per.toFixed(2)), w });
    t += per + (i % 7 === 0 ? 0.18 : 0.05);
    i++;
  }
  return {
    words,
    text: words.map((x) => x.w).join(' '),
    language: 'en',
    engine: 'demo',
  };
}

class Engine {
  constructor({ binDir, modelDir }) {
    this.binDir = binDir;
    this.modelDir = modelDir;
    this.binPath = path.join(binDir, 'whisper-cli.exe');
    this.altBinPath = path.join(binDir, 'main.exe');
    this.binaryCuda = this._detectCudaBuild();
  }

  _detectCudaBuild() {
    try {
      const dl = fs.readdirSync(this.binDir).map((f) => f.toLowerCase());
      // cublas/cudart shipped next to the exe == CUDA build
      return dl.some((f) => f.includes('cublas') || f.includes('cudart') || f.includes('cudnn'));
    } catch {
      return false;
    }
  }

  get binary() {
    if (fs.existsSync(this.binPath)) return this.binPath;
    if (fs.existsSync(this.altBinPath)) return this.altBinPath;
    return null;
  }

  get models() {
    return listModels(this.modelDir);
  }

  resolveModel(nameOrId) {
    const want = String(nameOrId || '').replace(/^ggml-/, '').replace(/\.bin$/, '');
    const models = this.models;
    return models.find((m) => m.id === want) || models.find((m) => m.id.startsWith(want)) || models[0] || null;
  }

  status() {
    const b = this.binary;
    const models = this.models;
    return {
      available: !!b && models.length > 0,
      binary: b,
      binaryCuda: this.binaryCuda,
      models,
      reason: !b
        ? `whisper-cli.exe not found in ${this.binDir} - running in DEMO mode.`
        : models.length === 0
          ? `no ggml model found in ${this.modelDir} - running in DEMO mode.`
          : null,
    };
  }

  /**
   * Transcribe one audio file.
   * @returns {Promise<{engine:'whisper'|'demo', words:Array, text:string, language:string|null, raw?:string}>}
   */
  async transcribe(audioPath, { model = 'small.en', language = 'en', device = 'auto', vad = true, chunkIndex = 0, timeoutMs = 15 * 60 * 1000 } = {}) {
    const st = this.status();
    if (!st.available) {
      let dur = 30;
      try {
        const h = require('./wav').readHeader(audioPath);
        const blockAlign = (h.channels * h.bitsPerSample) / 8;
        dur = Math.max(1, (fs.statSync(audioPath).size - 44) / (blockAlign * h.sampleRate));
      } catch { /* fall back to 30 s */ }
      return { ...demoTranscribe(dur, chunkIndex), reason: st.reason };
    }

    const m = this.resolveModel(model);
    const outBase = path.join(path.dirname(audioPath), `.whisper_${path.basename(audioPath, '.wav')}`);
    const outJson = `${outBase}.json`;

    const args = [
      '-m', path.join(this.modelDir, m.file),
      '-f', audioPath,
      '-l', language || 'en',
      '-ml', '1',                 // short timestamped segments
      '-sow',                     // split at words, NEVER at subword/UTF-8 token boundaries
      '-oj',                      // output json
      '-of', outBase,             // output file base
      '-pp',                      // progress to stdout (parsed for live %)
      '-t', String(Math.max(2, Math.min(8, require('os').cpus().length))),
    ];
    // `vad` is a session preference reserved for a configured VAD model. It must not map
    // to -nf: that flag disables decoding retries and has nothing to do with silence/VAD.
    if (device === 'cpu') args.push('-ng');
    if (this.binaryCuda && device !== 'cpu') args.push('-fa'); // flash attention on GPU

    await this._run(this.binary, args, timeoutMs);

    if (!fs.existsSync(outJson)) {
      throw new Error(`whisper produced no JSON for ${path.basename(audioPath)}`);
    }
    const parsed = parseWhisperJson(fs.readFileSync(outJson, 'utf8'));
    try { fs.unlinkSync(outJson); } catch { /* keep going */ }
    return { ...parsed, engine: 'whisper' };
  }

  _run(bin, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { windowsHide: true });
      let stderr = '';
      let settled = false;
      const to = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        reject(new Error(`whisper timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
      child.stdout.on('data', () => { /* progress; ignored for now */ });
      child.on('error', (e) => {
        if (settled) return;
        settled = true; clearTimeout(to);
        reject(new Error(`cannot start whisper: ${e.message}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true; clearTimeout(to);
        if (code === 0) resolve();
        else reject(new Error(`whisper exited ${code}: ${stderr.split(/\r?\n/).slice(-4).join(' | ')}`));
      });
    });
  }
}

module.exports = { Engine, parseWhisperJson, demoTranscribe, listModels, SENTENCE_END, WORD_CAP, cleanWhisperWords, collapseLoops };
