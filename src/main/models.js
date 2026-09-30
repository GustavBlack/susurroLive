'use strict';
/**
 * Model manager: knows the whisper.cpp ggml catalogue, what is on disk, and can
 * stream new models down from HuggingFace with progress + cancel.
 *
 * The default English model ships inside the app; the large multilingual models are
 * bundled too. Anything else can be fetched from the Settings drawer at runtime.
 */
const fs = require('fs');
const path = require('path');
const { once } = require('events');

const BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

/** Known-good ggml models (sizes are the real on-disk sizes). */
const CATALOG = [
  { id: 'tiny.en', file: 'ggml-tiny.en.bin', mb: 75, lang: 'en', quality: 1,
    note: 'Fastest. Lowest accuracy.' },
  { id: 'base.en', file: 'ggml-base.en.bin', mb: 142, lang: 'en', quality: 2,
    note: 'Fast and light.' },
  { id: 'small.en', file: 'ggml-small.en.bin', mb: 466, lang: 'en', quality: 3,
    note: 'Default English. The quality/speed knee.' },
  { id: 'medium.en', file: 'ggml-medium.en.bin', mb: 1500, lang: 'en', quality: 4,
    note: 'High-accuracy English.' },
  { id: 'large-v3-turbo', file: 'ggml-large-v3-turbo.bin', mb: 1500, lang: 'multi', quality: 4.5,
    note: 'Multilingual. Near-large quality, roughly 2x faster than large-v3.' },
  { id: 'large-v3', file: 'ggml-large-v3.bin', mb: 2900, lang: 'multi', quality: 5,
    note: 'Multilingual. Best quality available. Slowest.' },
];

class ModelManager {
  /**
   * @param {{modelDir:string, emit:(evt:string, payload:any)=>void}} opts
   */
  constructor({ modelDir, emit }) {
    this.modelDir = modelDir;
    this.emit = emit;
    this.jobs = new Map(); // id -> AbortController
  }

  /** Catalogue merged with on-disk state. */
  list() {
    return CATALOG.map((m) => {
      const p = path.join(this.modelDir, m.file);
      let installed = false;
      let bytes = 0;
      try {
        const st = fs.statSync(p);
        bytes = st.size;
        // guard against a truncated file (a .part left behind is ignored)
        installed = st.size > 1024;
      } catch { /* not installed */ }
      const partial = fs.existsSync(`${p}.part`);
      return {
        ...m,
        installed,
        bytes,
        mb: installed ? Math.round(bytes / 1e6) : m.mb,
        downloading: this.jobs.has(m.id),
        partial,
      };
    });
  }

  isDownloading(id) { return this.jobs.has(id); }

  /**
   * Stream a model to disk. Emits:
   *   modelProgress {id, got, total, pct}
   *   modelDone     {id}
   *   modelError    {id, error}
   */
  async download(id) {
    const entry = CATALOG.find((m) => m.id === id);
    if (!entry) throw new Error(`unknown model: ${id}`);
    if (this.jobs.has(id)) return { ok: false, error: 'already downloading' };

    fs.mkdirSync(this.modelDir, { recursive: true });
    const dest = path.join(this.modelDir, entry.file);
    const part = `${dest}.part`;

    const ac = new AbortController();
    this.jobs.set(id, ac);
    this.emit('modelProgress', { id, got: 0, total: entry.mb * 1e6, pct: 0 });

    let out = null;
    try {
      const res = await fetch(BASE_URL + entry.file, { signal: ac.signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      const total = Number(res.headers.get('content-length') || 0) || entry.mb * 1e6;
      let got = 0;
      let lastEmit = 0;

      out = fs.createWriteStream(part);
      const reader = res.body.getReader();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(Buffer.from(value))) await once(out, 'drain');
        const now = Date.now();
        if (now - lastEmit > 200) {
          lastEmit = now;
          this.emit('modelProgress', { id, got, total, pct: total ? got / total : 0 });
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      out = null;

      if (got < 1024) throw new Error('download produced an empty file');
      fs.renameSync(part, dest);

      this.jobs.delete(id);
      this.emit('modelDone', { id, mb: Math.round(got / 1e6) });
      return { ok: true, id, bytes: got };
    } catch (err) {
      if (out) { try { out.destroy(); } catch { /* ignore */ } }
      try { fs.unlinkSync(part); } catch { /* nothing to clean */ }
      this.jobs.delete(id);

      const aborted = ac.signal.aborted || err.name === 'AbortError';
      if (aborted) {
        this.emit('modelError', { id, error: 'cancelled', cancelled: true });
        return { ok: false, cancelled: true };
      }
      this.emit('modelError', { id, error: String(err.message || err) });
      return { ok: false, error: String(err.message || err) };
    }
  }

  cancel(id) {
    const ac = this.jobs.get(id);
    if (!ac) return { ok: false, error: 'not downloading' };
    ac.abort();
    return { ok: true };
  }

  /** Delete an installed model from disk. */
  remove(id) {
    const entry = CATALOG.find((m) => m.id === id);
    if (!entry) return { ok: false, error: `unknown model: ${id}` };
    if (this.jobs.has(id)) return { ok: false, error: 'still downloading' };
    const p = path.join(this.modelDir, entry.file);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      try { fs.unlinkSync(`${p}.part`); } catch { /* none */ }
      this.emit('modelRemoved', { id });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }
}

module.exports = { ModelManager, CATALOG, BASE_URL };
