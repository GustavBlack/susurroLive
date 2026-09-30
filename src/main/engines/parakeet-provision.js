'use strict';
/**
 * In-app provisioning for the Parakeet engine (sherpa-onnx offline CLI + NeMo TDT model).
 *
 * Downloads the two pinned GitHub release archives with progress/cancel (same UX contract as
 * the whisper ModelManager), extracts them with the tar.exe that ships with Windows 10/11,
 * and lands the files in a WRITABLE location:
 *
 *   packaged: app.getPath('userData')/engines/sherpa   (resources/ is read-only)
 *   dev:      repo native/bin/sherpa + native/models/sherpa  (keeps the dev layout canonical)
 *
 * Layout produced (packaged): <dir>/sherpa-onnx-offline.exe + DLLs, <dir>/models/{enc,dec,join,tokens}
 * searchPaths() in the engine looks for the model dir sibling `models/` OR a `models` subdir —
 * see engines/parakeet.js ProvisionedLayout note.
 *
 * Contract: download() resolves {ok} | {ok:false, error|cancelled}; emits:
 *   parakeetProgress {phase:'engine'|'model', got, total, pct}
 *   parakeetDone     {}
 *   parakeetError    {error, cancelled?}
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');

const SHERPA_VERSION = '1.13.8';
const ENGINE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_VERSION}/sherpa-onnx-v${SHERPA_VERSION}-win-x64-shared-MT-Release-no-tts.tar.bz2`;
const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2';

/** Known-good pinned sizes for sanity checks (bytes; download total when no content-length). */
const ENGINE_MB = 23;
const MODEL_MB = 487;

class ParakeetProvisioner {
  /**
   * @param {{dir:string, emit:(evt:string, payload:any)=>void}} opts
   *   dir: the writable root; exe lands in <dir>/sherpa/, model files in <dir>/sherpa/models/
   */
  constructor({ dir, emit }) {
    this.dir = dir;
    this.emit = emit;
    this.busy = null; // 'engine' | 'model' | null
    this.ac = null;
  }

  static exePath(dir) { return path.join(dir, 'sherpa', 'sherpa-onnx-offline.exe'); }
  static modelDir(dir) { return path.join(dir, 'sherpa', 'models'); }

  /** Are both pieces already provisioned? */
  provisioned() {
    return fs.existsSync(ParakeetProvisioner.exePath(this.dir))
      && fs.existsSync(path.join(ParakeetProvisioner.modelDir(this.dir), 'tokens.txt'));
  }

  cancel() {
    if (this.ac) this.ac.abort();
    return { ok: true };
  }

  /** Download both archives (skips pieces already on disk), extract, verify. */
  async download() {
    if (this.busy) return { ok: false, error: 'already downloading' };
    this.busy = 'engine';
    try {
      if (!fs.existsSync(ParakeetProvisioner.exePath(this.dir))) {
        const ok = await this._fetchAndExtract(ENGINE_URL, ENGINE_MB, 'engine', (staged) => {
          // archive layout: <root>/bin/{sherpa-onnx-offline.exe, onnxruntime*.dll}
          const binDir = fs.existsSync(path.join(staged.root, 'bin'))
            ? path.join(staged.root, 'bin')
            : staged.root;
          const out = path.join(this.dir, 'sherpa');
          fs.mkdirSync(out, { recursive: true });
          for (const f of fs.readdirSync(binDir)) {
            if (/\.exe$/i.test(f) || /\.dll$/i.test(f)) fs.copyFileSync(path.join(binDir, f), path.join(out, f));
          }
        });
        if (!ok.ok) return ok;
      } else {
        this.busy = 'model';
      }

      if (!fs.existsSync(path.join(ParakeetProvisioner.modelDir(this.dir), 'tokens.txt'))) {
        this.busy = 'model';
        const ok = await this._fetchAndExtract(MODEL_URL, MODEL_MB, 'model', (staged) => {
          const root = staged.root;
          const out = ParakeetProvisioner.modelDir(this.dir);
          fs.mkdirSync(out, { recursive: true });
          // the archive root holds the four model files (sometimes nested one level)
          let src = root;
          const inner = fs.readdirSync(root).filter((f) => f.endsWith('.onnx') || f === 'tokens.txt');
          if (!inner.length) {
            const sub = fs.readdirSync(root).map((f) => path.join(root, f)).filter((p) => fs.statSync(p).isDirectory())[0];
            if (sub) src = sub;
          }
          for (const f of fs.readdirSync(src)) {
            if (f.endsWith('.onnx') || f === 'tokens.txt') fs.copyFileSync(path.join(src, f), path.join(out, f));
          }
        });
        if (!ok.ok) return ok;
      }

      // verify
      const missing = ['sherpa-onnx-offline.exe', 'models/encoder.int8.onnx', 'models/decoder.int8.onnx', 'models/joiner.int8.onnx', 'models/tokens.txt']
        .filter((rel) => !fs.existsSync(path.join(this.dir, 'sherpa', rel)));
      if (missing.length) throw new Error(`missing after install: ${missing.join(', ')}`);

      this.emit('parakeetDone', {});
      return { ok: true };
    } catch (err) {
      const cancelled = this.ac?.signal.aborted || err.name === 'AbortError';
      const error = cancelled ? 'cancelled' : String(err.message || err);
      this.emit('parakeetError', { error, cancelled });
      return cancelled ? { ok: false, cancelled: true } : { ok: false, error };
    } finally {
      this.busy = null;
      this.ac = null;
    }
  }

  /** Stream one archive to temp, tar -xjf it, hand the staged root to copy. */
  async _fetchAndExtract(url, mb, phase, copy) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'susurro-parakeet-'));
    const archive = path.join(tmpDir, 'payload.tar.bz2');
    this.ac = new AbortController();
    this.emit('parakeetProgress', { phase, got: 0, total: mb * 1e6, pct: 0 });

    try {
      const res = await fetch(url, { signal: this.ac.signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const total = Number(res.headers.get('content-length') || 0) || mb * 1e6;
      let got = 0;
      let lastEmit = 0;
      const out = fs.createWriteStream(archive);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(Buffer.from(value))) await once(out, 'drain');
        const now = Date.now();
        if (now - lastEmit > 200) {
          lastEmit = now;
          this.emit('parakeetProgress', { phase, got, total, pct: total ? got / total : 0 });
        }
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      if (got < 1024) throw new Error('download produced an empty file');

      // Windows 10 1803+ ships bsdtar, which reads .tar.bz2 directly. Run it via cmd with a
      // short 8.3-free cwd: bsdtar treats "C:\..." in -C/-f as a remote host spec unless
      // --force-local, and cwd-relative paths sidestep the colon entirely.
      const extract = await new Promise((resolve) => {
        const child = spawn('cmd.exe', ['/d', '/s', '/c', 'tar -xjf payload.tar.bz2'], {
          windowsHide: true, cwd: tmpDir, stdio: ['ignore', 'ignore', 'pipe'],
        });
        let exErr = '';
        child.stderr.on('data', (d) => { exErr += d.toString(); if (exErr.length > 4000) exErr = exErr.slice(-4000); });
        child.on('error', (e) => resolve({ code: -1, err: e.message }));
        child.on('close', (code) => resolve({ code, err: exErr }));
      });
      if (extract.code !== 0) throw new Error(`extract failed (tar exit ${extract.code}): ${String(extract.err || '').split(/\r?\n/)[0]}`);

      const root = fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f)).filter((p) => fs.statSync(p).isDirectory())[0];
      if (!root) throw new Error('archive layout unexpected: no root directory');
      copy({ root });
      return { ok: true };
    } finally {
      this.ac = null;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

module.exports = { ParakeetProvisioner, SHERPA_VERSION, ENGINE_URL, MODEL_URL };
