'use strict';
/**
 * Transcription pipeline: a persisted queue + a bounded worker pool.
 *
 *   pending -> queued -> running -> done
 *                            \-> error --(retry)--> queued
 *
 * Statuses live in session.json so a crash mid-flight is recoverable.
 */
const path = require('path');
const os = require('os');

/** Chunks shorter than this are near-silence; whisper hallucinates on them. */
const MIN_CHUNK_SEC = 1.0;

function concurrencyFor(gpu, device) {
  if (device === 'cpu') return Math.max(1, Math.min(4, Math.ceil((os.cpus().length || 4) / 2)));
  if (device === 'cuda' || gpu?.accelerated) return 1;   // one model in VRAM
  return Math.max(1, Math.min(2, Math.ceil((os.cpus().length || 4) / 2)));
}

class Pipeline {
  /**
   * @param {object} deps
   * @param {import('./whisper').Engine} deps.engine
   * @param {() => object|null} deps.getSession
   * @param {(session:object) => void} deps.onPersist
   * @param {(evt:string, payload:any) => void} deps.emit
   */
  constructor({ engine, getSession, onPersist, emit, gpu, device }) {
    this.engine = engine;
    this.getSession = getSession;
    this.onPersist = onPersist;
    this.emit = emit;
    this.gpu = gpu;
    this.device = device || 'auto';
    this.concurrency = concurrencyFor(gpu, this.device);
    this.running = 0;
    this.draining = false;
  }

  get queueDepth() {
    const s = this.getSession();
    if (!s) return 0;
    return s.chunks.filter((c) => c.status === 'queued' || c.status === 'running').length;
  }

  get remaining() {
    const s = this.getSession();
    if (!s) return 0;
    return s.chunks.filter((c) => c.status === 'pending' || c.status === 'queued' || c.status === 'running').length;
  }

  enqueue(index) {
    const s = this.getSession();
    if (!s) return;
    const chunk = s.chunks.find((c) => c.index === index);
    if (!chunk) return;
    if (chunk.status === 'done' || chunk.status === 'running') return;
    chunk.status = 'queued';
    this.onPersist(s);
    this.emit('chunk', { index, status: 'queued' });
    this._pump();
  }

  /** Reset errored chunks to pending and queue everything outstanding. */
  enqueueAllOutstanding() {
    const s = this.getSession();
    if (!s) return;
    for (const c of s.chunks) {
      if (c.status !== 'done' && c.status !== 'running') c.status = 'queued';
    }
    this.onPersist(s);
    this.emit('chunks', s.chunks.map((c) => ({ index: c.index, status: c.status })));
    this._pump();
  }

  _pump() {
    const s = this.getSession();
    if (!s) return;

    while (this.running < this.concurrency) {
      const next = s.chunks
        .filter((c) => c.status === 'queued')
        .sort((a, b) => a.index - b.index)[0];
      if (!next) break;
      this._runChunk(s, next);
    }

    // Have we drained everything?
    const outstanding = s.chunks.filter(
      (c) => c.status === 'pending' || c.status === 'queued' || c.status === 'running',
    );
    if (outstanding.length === 0) {
      this.draining = false;
      this.emit('pipeline', { state: 'idle', remaining: 0, running: 0 });
    } else {
      this.emit('pipeline', {
        state: this.running > 0 ? 'working' : 'waiting',
        remaining: outstanding.length,
        running: this.running,
      });
    }
  }

  async _runChunk(session, chunk) {
    this.running += 1;
    chunk.status = 'running';
    chunk.attempts = (chunk.attempts || 0) + 1;
    chunk.error = null;
    this.onPersist(session);
    this.emit('chunk', { index: chunk.index, status: 'running' });

    const audioPath = path.join(session.folder, chunk.audioFile);
    const started = Date.now();

    try {
      // Very short trailing chunks are almost pure silence and whisper hallucinates on
      // them - producing words with timestamps far outside the clip (observed: 7 words at
      // t<=10s inside a 0.76s chunk). That corrupts the global timeline, so skip them.
      if ((chunk.durationSec || 0) < MIN_CHUNK_SEC) {
        chunk.words = [];
        chunk.text = '';
        chunk.engine = 'skipped';
        chunk.status = 'done';
        chunk.ms = 0;
        chunk.note = `skipped: ${chunk.durationSec}s is below the ${MIN_CHUNK_SEC}s floor`;
        this.emit('chunk', { index: chunk.index, status: 'done' });
        return;
      }

      const res = await this.engine.transcribe(audioPath, {
        engine: session.model?.engine,
        model: session.model?.name,
        language: session.model?.language,
        device: session.model?.device,
        vad: session.model?.vad,
        chunkIndex: chunk.index,
      });

      // Store CHUNK-LOCAL times on the chunk: self-contained, re-runnable, idempotent.
      // rebuildTranscript() applies offsetSec when it builds the global timeline.
      // Clamp: discard words whose local time falls outside the chunk's real duration
      // (whisper can drift past the end of very short or noisy clips).
      const dur = chunk.durationSec || 0;
      const localWords = res.words
        .filter((w) => Number.isFinite(w.t) && w.t >= 0 && w.t <= dur + 0.5)
        .map((w) => ({
          t: Number(w.t.toFixed(3)),
          d: Number(w.d.toFixed(3)),
          w: w.w,
        }));

      chunk.words = localWords;
      chunk.text = res.text;
      chunk.engine = res.engine;
      chunk.status = 'done';
      chunk.ms = Date.now() - started;
      const lastWord = localWords[localWords.length - 1];
      chunk.spokenSec = lastWord ? Number((lastWord.t + lastWord.d).toFixed(2)) : 0;

      // per-chunk sidecar transcript
      try {
        const out = path.join(session.folder, 'transcripts', `chunk_${String(chunk.index).padStart(4, '0')}.json`);
        const fs = require('fs');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify({
          index: chunk.index, offsetSec: chunk.offsetSec, engine: res.engine,
          language: res.language, words: localWords, text: res.text,
        }, null, 2));
        chunk.transcriptFile = path.relative(session.folder, out).replace(/\\/g, '/');
      } catch { /* non-fatal */ }

      this.emit('chunk', { index: chunk.index, status: 'done' });
      this.emit('chunkDone', {
        index: chunk.index,
        words: localWords.map((w) => ({ ...w, t: Number((chunk.offsetSec + w.t).toFixed(3)) })),
        engine: res.engine,
      });
    } catch (err) {
      chunk.status = 'error';
      chunk.error = String(err.message || err);
      this.emit('chunk', { index: chunk.index, status: 'error', error: chunk.error });
    } finally {
      this.running -= 1;
      this.onPersist(session);
      this._pump();
    }
  }
}

module.exports = { Pipeline, concurrencyFor };
