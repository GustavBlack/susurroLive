// audio.js - capture engine: mic + system loopback -> gain -> analyser -> mix -> PCM firehose

const PREFERRED_RATE = 48000;

/**
 * A track is one source in the array.
 * @typedef {{id:string, kind:'mic'|'loopback', deviceId:string|null, label:string, gain:number, muted:boolean}} SourceCfg
 */

export class CaptureEngine {
  /** @param {{onPcm:(ab:ArrayBuffer)=>void}} opts */
  constructor({ onPcm }) {
    this.onPcm = onPcm;
    this.ctx = null;
    this.tracks = [];      // [{cfg, stream, srcNode, gainNode, analyser, buf}]
    this.mix = null;
    this.proc = null;
    this.running = false;
    this.paused = false;
    this.sampleRate = PREFERRED_RATE;
  }

  async _openStream(cfg) {
    if (cfg.kind === 'loopback') {
      // Electron desktop-capture loopback: captures the system mix on Windows.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: cfg.deviceId,
          },
        },
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: cfg.deviceId,
          },
        },
      });
      // We only want the audio: drop the mandatory video track.
      for (const t of stream.getVideoTracks()) {
        t.stop();
        stream.removeTrack(t);
      }
      return stream;
    }

    // microphone
    const constraints = {
      audio: {
        deviceId: cfg.deviceId ? { exact: cfg.deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  async start(sources) {
    if (this.running) return { ok: false, error: 'already running' };

    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: PREFERRED_RATE, latencyHint: 'interactive' });
    } catch {
      ctx = new AudioContext();
    }
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;

    const mix = ctx.createGain();
    mix.gain.value = 1;

    for (const cfg of sources) {
      let stream;
      try {
        stream = await this._openStream(cfg);
      } catch (err) {
        await this.stop();
        return { ok: false, error: `${cfg.label}: ${err.message || err}` };
      }

      const srcNode = ctx.createMediaStreamSource(stream);
      const gainNode = ctx.createGain();
      gainNode.gain.value = cfg.muted ? 0 : cfg.gain ?? 1;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;

      srcNode.connect(gainNode);
      gainNode.connect(analyser);
      analyser.connect(mix);

      this.tracks.push({
        cfg: { ...cfg },
        stream,
        srcNode,
        gainNode,
        analyser,
        timeBuf: new Float32Array(analyser.fftSize),
        rms: 0,
        peak: 0,
        smooth: 0,
      });
    }

    if (this.tracks.length === 0) {
      await ctx.close();
      this.ctx = null;
      return { ok: false, error: 'no sources' };
    }

    // Mix -> downmix to mono PCM16 -> main
    const proc = ctx.createScriptProcessor(4096, 2, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;                 // silent: we never want to monitor ourselves
    mix.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);

    proc.onaudioprocess = (e) => {
      if (!this.running || this.paused) return;
      const n = e.inputBuffer.length;
      const ch0 = e.inputBuffer.getChannelData(0);
      const ch1 = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : null;
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        let v = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
        if (v > 1) v = 1; else if (v < -1) v = -1;
        out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      try { this.onPcm(out.buffer); } catch { /* ignore */ }
    };

    this.mix = mix;
    this.proc = proc;
    this.running = true;
    this.paused = false;
    return { ok: true, sampleRate: this.sampleRate, tracks: this.tracks.length };
  }

  pause() {
    this.paused = true;
    for (const t of this.tracks) {
      for (const track of t.stream.getAudioTracks()) track.enabled = false;
      t.rms = t.peak = t.smooth = 0;
    }
  }

  resume() {
    for (const t of this.tracks) {
      for (const track of t.stream.getAudioTracks()) track.enabled = true;
    }
    this.paused = false;
  }

  /** Compute per-track levels (called from the render loop). */
  updateLevels() {
    if (this.paused || !this.running) return;
    for (const t of this.tracks) {
      t.analyser.getFloatTimeDomainData(t.timeBuf);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < t.timeBuf.length; i++) {
        const v = t.timeBuf[i];
        sum += v * v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      t.rms = Math.sqrt(sum / t.timeBuf.length);
      t.peak = peak;
      // fast attack / slow release
      const target = t.rms;
      t.smooth = target > t.smooth
        ? t.smooth + (target - t.smooth) * 0.55
        : t.smooth + (target - t.smooth) * 0.10;
    }
  }

  setMute(id, muted) {
    const t = this.tracks.find((x) => x.cfg.id === id);
    if (!t) return;
    t.cfg.muted = muted;
    t.gainNode.gain.value = muted ? 0 : t.cfg.gain ?? 1;
  }

  setGain(id, gain) {
    const t = this.tracks.find((x) => x.cfg.id === id);
    if (!t) return;
    t.cfg.gain = gain;
    if (!t.cfg.muted) t.gainNode.gain.value = gain;
  }

  /** Remove one source from the live mix. */
  remove(id) {
    const i = this.tracks.findIndex((x) => x.cfg.id === id);
    if (i < 0) return;
    const t = this.tracks[i];
    try { t.srcNode.disconnect(); t.gainNode.disconnect(); t.analyser.disconnect(); } catch { /* ignore */ }
    for (const tr of t.stream.getTracks()) tr.stop();
    this.tracks.splice(i, 1);
  }

  async stop() {
    this.running = false;
    this.paused = false;
    if (this.proc) { this.proc.onaudioprocess = null; try { this.proc.disconnect(); } catch { /* ignore */ } }
    for (const t of this.tracks) {
      try { t.srcNode.disconnect(); t.gainNode.disconnect(); t.analyser.disconnect(); } catch { /* ignore */ }
      for (const tr of t.stream.getTracks()) tr.stop();
    }
    this.tracks = [];
    this.proc = null;
    this.mix = null;
    if (this.ctx) {
      try { await this.ctx.close(); } catch { /* ignore */ }
      this.ctx = null;
    }
  }
}

/** Enumerate microphones (renderer-side). */
export async function listMicrophones() {
  try {
    // permissions label fix: enumerate once, and again if labels are empty
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.every((d) => !d.label)) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
      } catch { /* denied; labels stay blank */ }
      devices = await navigator.mediaDevices.enumerateDevices();
    }
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch {
    return [];
  }
}
