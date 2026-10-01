// A lattice of softly illuminated tiles, tinted by the active theme (v1.5).
// Idle: eight slow light fields on a per-field schedule. Import: progress-aware
// rising currents. Audio: source/frequency levels. Reading current: scroll energy.
// All movement uses elapsed seconds; no random flashes or frame-count particles.

import { getTheme, DEFAULT_THEME, hexRgb, mixHex, speakerColors } from './theme/themes.js';

const COLS = 12;
const clamp = (n, min = 0, max = 1) => Math.max(min, Math.min(max, n));
const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
const gauss = (d, width) => Math.exp(-0.5 * (d / width) ** 2);

// Canvas palette, derived from the active theme. Mutable module state: the
// Visualizer.applyThemePalette() method re-derives these on a theme swap. The
// field functions below close over the module bindings, so reassignment
// propagates to every consumer on the next frame.
function buildPalette(p, mode) {
  const pole = mode === 'light' ? '#000000' : '#FFFFFF';
  const ink = hexRgb(p.surface2);
  return {
    ink,
    // energy ramp: ink -> dim accent -> accent -> pale highlight
    ramp: [ink, hexRgb(mixHex(p.accent, p.surface2, 0.45)), hexRgb(p.accent), hexRgb(mixHex(p.accentStrong, p.text, 0.4))],
    sage: hexRgb(mixHex(p.success, p.textSec, 0.4)),
    moss: hexRgb(p.success),
    rust: hexRgb(p.record),
    mutedRgb: hexRgb(p.textMut),
    spk: speakerColors(p, mode),
    lip: mixHex(p.accentStrong, p.text, 0.5),     // per-tile specular lip
    foot: mixHex(p.bg, '#000000', 0.35),          // per-tile shadow foot
  };
}
const _seed = getTheme(DEFAULT_THEME).dark;
let PAL = buildPalette(_seed, 'dark');
let RAMP = PAL.ramp;
let INK = PAL.ink;
let SAGE_RGB = PAL.sage;
let MOSS_RGB = PAL.moss;
let RUST_RGB = PAL.rust;
let MUTED_RGB = PAL.mutedRgb;

// v1.2 choreography (docs/v1.2-animations.md §A): per-field dwell on a fixed order,
// so the dissolve still joins exactly — including the last-to-first wrap. Calm
// fields dwell longer; active ones rotate faster. No field sits next to itself.
const IDLE_FADE = 4;
const IDLE_SCHEDULE = [
  { field: 0, dwell: 18 }, // woven folds
  { field: 4, dwell: 22 }, // ink in water
  { field: 2, dwell: 14 }, // diagonal weave
  { field: 5, dwell: 20 }, // aurora curtain
  { field: 1, dwell: 16 }, // ripples
  { field: 3, dwell: 22 }, // wandering ring
  { field: 6, dwell: 16 }, // ember drift
  { field: 7, dwell: 22 }, // tide
];
const IDLE_STARTS = (() => {
  const starts = [];
  let acc = 0;
  for (const s of IDLE_SCHEDULE) { starts.push(acc); acc += s.dwell; }
  return starts;
})();
const IDLE_TOTAL = IDLE_SCHEDULE.reduce((s, f) => s + f.dwell, 0);
const PULSE_DUR = 2.5;   // chunk:done / chunk:error heartbeat
const SWEEP_DUR = 1.4;   // completion wash
const SCROLL_DECAY = 0.12; // s without a scroll event before velocity reads as zero

function ramp(t) {
  const n = clamp(t) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(n));
  return RAMP[i].map((v, k) => v + (RAMP[i + 1][k] - v) * (n - i));
}

function hash2(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(x - ix), fy = smooth(y - iy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// Four related, continuous light fields. A fixed order makes the long dissolve
// join exactly the next field, including the last-to-first transition.
const IDLE_FIELDS = [
  (x, y, t) => {
    const center = 0.5 + Math.sin(y * 5.4 - t * 0.29) * 0.23;
    const fold = 0.5 + Math.sin(y * 5.4 - t * 0.29 + 2.3) * 0.25;
    return gauss(x - center, 0.13) * 0.49 + gauss(x - fold, 0.085) * 0.23;
  },
  (x, y, t) => {
    const d = Math.hypot((x - 0.5) * 0.8, y - 0.48);
    const ripple = 0.5 + Math.sin(d * 20 - t * 0.74) * 0.5;
    return ripple ** 4 * 0.53 * gauss(d, 0.65);
  },
  (x, y, t) => {
    const bend = noise(x * 2 + t * 0.035, y * 2) * 2;
    const weave = 0.5 + Math.sin(x * 5.5 + y * 9 - t * 0.48 + bend) * 0.5;
    return weave ** 3 * 0.48 + gauss(x - 0.7 + y * 0.3, 0.14) * 0.09;
  },
  (x, y, t) => {
    const centerX = 0.5 + Math.sin(t * 0.21) * 0.22;
    const centerY = 0.5 + Math.cos(t * 0.17) * 0.22;
    const d = Math.hypot((x - centerX) * 0.7, y - centerY);
    return gauss(d - 0.25, 0.065) * 0.51 + gauss(d, 0.3) * 0.09;
  },
  // ---- v1.2 fields (docs/v1.2-animations.md §A). Same contract: pure (x, y, t),
  // hash-seeded determinism, envelopes that fade so the dissolve joins cleanly.
  (x, y, t) => {
    // ember drift: hash-seeded sparks on slow Lissajous paths with life envelopes
    let e = 0;
    for (let i = 0; i < 6; i++) {
      const px = 0.13 + hash2(i, 71) * 0.74 + Math.sin(t * (0.11 + hash2(i, 3) * 0.07) + i * 2.1) * 0.16;
      const py = 0.15 + hash2(i, 137) * 0.7 + Math.cos(t * (0.09 + hash2(i, 5) * 0.06) + i * 1.3) * 0.22;
      const life = 0.5 + 0.5 * Math.sin(t * 0.13 + i * 1.9);
      e += gauss(Math.hypot(x - px, (y - py) * 0.8), 0.05 + life * 0.03) * life * life * 0.46;
    }
    return e;
  },
  (x, y, t) => {
    // ink in water: domain-warped value noise, soft-thresholded into slow pools
    const warp = (noise(t * 0.06, 7.3) - 0.5) * 1.6;
    const n = (noise(x * 2.2 + warp, y * 2.2 - t * 0.045)
      + 0.5 * noise(x * 4.5 - warp * 0.7, y * 4.5 + t * 0.03)) / 1.5;
    return smooth((n - 0.42) * 2.6) * 0.52;
  },
  (x, y, t) => {
    // aurora curtain: two swaying vertical gaussians, brighter toward the top
    const c1 = 0.32 + Math.sin(t * 0.16 + 0.9) * 0.18 + Math.sin(t * 0.085 + 2.4) * 0.09;
    const c2 = 0.68 + Math.sin(t * 0.13 + 3.6) * 0.18 + Math.sin(t * 0.07 + 1.1) * 0.09;
    const mod = 0.55 + 0.45 * noise(y * 3 - t * 0.05, 11.2);
    return (gauss(x - c1, 0.075) + gauss(x - c2, 0.095)) * mod * (0.38 + 0.5 * y) * 0.44;
  },
  (x, y, t) => {
    // tide: a foam line drifting up/down over a broad body; slowest of the set
    const line = 0.45 + Math.sin(t * 0.11) * 0.16 + (noise(t * 0.05, 3.1) - 0.5) * 0.14;
    const foam = gauss(y - line, 0.05) * (0.75 + noise(x * 7 + t * 0.03, y * 26) * 0.5);
    return foam * 0.55 + smooth((line - y) / 0.3) * 0.085;
  },
];

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = 'idle'; // idle | capture | paused | playback | import
    this.tracks = [];
    this.analyser = null;
    this.spectrum = null;
    this.colors = PAL.spk;
    this.levels = new Float32Array(COLS);
    this.clock = 0;
    this.modeStarted = 0;
    this.lastFrame = null;
    this.lastPaint = null;
    this.dirty = true;
    // v1.2: reading current, import wavefront, transient overlays
    this.scrollVel = 0;        // signed px/s from the transcript scroll listener
    this.scrollEnergy = 0;     // 0..1 envelope driving the streak overlay
    this.scrollPhase = 0;      // integrates velocity; gives the streaks their direction
    this.lastScrollAt = -10;
    this.importProgress = null; // null = progress-blind (classic import field)
    this.pulses = [];          // { start, kind: 'done' | 'error' }
    this.sweepAt = -10;
    this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.onMotionChange = () => { this.dirty = true; };
    this.motionQuery.addEventListener('change', this.onMotionChange);
    // A visibility event is needed as rAF normally stops entirely in hidden tabs.
    this.onVisibilityChange = () => { this.lastFrame = null; this.lastPaint = null; this.dirty = true; };
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    const rect = canvas.getBoundingClientRect();
    this.width = rect.width || canvas.width;
    this.height = rect.height || canvas.height;
    this.resizeObserver = new ResizeObserver(([entry]) => {
      this.width = entry.contentRect.width;
      this.height = entry.contentRect.height;
      this.dirty = true;
    });
    this.resizeObserver.observe(canvas);
  }

  _setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.modeStarted = this.clock;
    this.levels.fill(0);
    this.dirty = true;
  }

  /** v1.5: re-derive the canvas palette for a theme swap (called from app.js). */
  applyThemePalette(theme, mode) {
    PAL = buildPalette(theme[mode === 'light' ? 'light' : 'dark'], mode === 'light' ? 'light' : 'dark');
    RAMP = PAL.ramp;
    INK = PAL.ink;
    SAGE_RGB = PAL.sage;
    MOSS_RGB = PAL.moss;
    RUST_RGB = PAL.rust;
    MUTED_RGB = PAL.mutedRgb;
    this.colors = PAL.spk;
    // live tracks cache their legend color — remap so meters follow the theme
    for (let i = 0; i < this.tracks.length; i++) {
      const c = PAL.spk[i % PAL.spk.length];
      this.tracks[i].color = c;
      this.tracks[i].rgb = hexRgb(c);
    }
    this.dirty = true;
  }

  setCapture(tracks) {
    this._setMode('capture');
    this.tracks = tracks.map((t, i) => ({
      label: t.cfg.label,
      muted: t.cfg.muted,
      live: t,
      color: this.colors[i % this.colors.length],
      rgb: hexRgb(this.colors[i % this.colors.length]),
    }));
    this.analyser = null;
  }

  setPaused() {
    this._setMode('paused');
    this.analyser = null;
  }

  setPlayback(analyser) {
    this._setMode('playback');
    this.analyser = analyser;
    if (analyser && this.spectrum?.length !== analyser.frequencyBinCount) {
      this.spectrum = new Uint8Array(analyser.frequencyBinCount);
    }
  }

  setImport(progress) {
    this._setMode('import');
    this.analyser = null;
    // Called with a 0..1 fraction, the import field gains a bottom-up wavefront.
    // Called with no argument, it stays progress-blind (classic behavior).
    this.importProgress = Number.isFinite(progress) ? clamp(progress) : null;
  }

  /** A soft band traveling down the grid: 'done' (moss) or 'error' (rust). */
  pulse(kind = 'done') {
    if (this.motionQuery.matches) return; // reduced motion: the chips already flash
    if (this.pulses.length < 4) this.pulses.push({ start: this.clock, kind: kind === 'error' ? 'error' : 'done' });
  }

  /** One top-to-bottom wash: the named "finished" moment before settling. */
  sweep() {
    if (this.motionQuery.matches) return;
    this.sweepAt = this.clock;
  }

  /** Feed the signed transcript scroll velocity (px/s); 0 or silence decays it. */
  setScrollVelocity(v) {
    if (Number.isFinite(v)) {
      this.scrollVel = clamp(v, -2000, 2000);
      this.lastScrollAt = this.clock;
    }
  }

  setIdle() {
    this._setMode('idle');
    this.tracks = [];
    this.analyser = null;
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.motionQuery.removeEventListener('change', this.onMotionChange);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  _layout() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.round(this.width * dpr), height = Math.round(this.height * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.dirty = true;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const gap = Math.max(2, this.width * 0.015);
    const cell = (this.width - gap * (COLS + 1)) / COLS;
    const rows = clamp(Math.floor((this.height - gap) / (cell + gap)), 1, 64);
    if (!this.grid || this.grid.rows !== rows || this.grid.cell !== cell || this.grid.height !== this.height) {
      const top = (this.height - rows * (cell + gap) + gap) / 2;
      this.grid = { rows, cell, gap, top, height: this.height };
      this.pixels = new Float32Array(COLS * rows * 4);
      for (let i = 0; i < COLS * rows; i++) this.pixels.set([...INK, 0], i * 4);
      this.dirty = true;
    }
    return this.grid;
  }

  draw(now = performance.now()) {
    if (!this.ctx || document.hidden || this.width < 40 || this.height < 8) {
      this.lastFrame = null;
      return;
    }
    const elapsed = this.lastFrame == null ? 0 : Math.max(0, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    // Large scheduling gaps resume gently; background time never advances a wave.
    this.clock += Math.min(elapsed, 0.1);
    const age = this.clock - this.modeStarted;
    const reduced = this.motionQuery.matches;
    const audio = this.mode === 'capture' || this.mode === 'playback';
    const layout = this._layout();
    // Paused settles still — but the reading current counts as life, so scrolling
    // through a paused session's transcript wakes the grid back up.
    const settled = this.mode === 'paused' && age > 2.2
      && this.scrollEnergy < 0.01 && Math.abs(this.scrollVel) < 1;
    if (!this.dirty && (settled || (reduced && !audio))) return;
    // Essential audio feedback remains available with reduced motion, at 10 Hz.
    const paintInterval = reduced ? 100 : 1000 / 60;
    if (!this.dirty && this.lastPaint != null && now - this.lastPaint < paintInterval - 1) return;
    const dt = this.lastPaint == null ? 1 / 60 : Math.min(0.1, (now - this.lastPaint) / 1000);
    this.lastPaint = now;
    // v1.2 transient overlays: prune dead pulses, then run the reading-current
    // envelope. Velocity target reads as zero once scroll events stop arriving;
    // the energy itself releases slowly so the grid exhales after you stop.
    if (this.pulses.length && this.pulses.some((p) => this.clock - p.start >= PULSE_DUR)) {
      this.pulses = this.pulses.filter((p) => this.clock - p.start < PULSE_DUR);
    }
    if (this.clock - this.lastScrollAt > SCROLL_DECAY) this.scrollVel = 0;
    const scrollable = (this.mode === 'idle' || this.mode === 'paused') && !reduced;
    const scrollTarget = scrollable ? clamp(Math.abs(this.scrollVel) / 900) : 0;
    const scrollResp = scrollTarget > this.scrollEnergy ? 0.05 : 0.32;
    this.scrollEnergy += (scrollTarget - this.scrollEnergy) * (1 - Math.exp(-dt / scrollResp));
    this.scrollPhase += (this.scrollVel / 1000) * dt * 2.4;
    const blend = reduced || settled ? 1 : 1 - Math.exp(-dt / (this.mode === 'paused' ? 0.28 : 0.095));
    this.dirty = false;
    const t = reduced ? 4.5 : age;
    const { ctx } = this;
    ctx.clearRect(0, 0, this.width, this.height);
    if (audio) this._readLevels(dt, reduced);
    const { rows, cell, gap, top } = layout;

    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < rows; r++) {
        const x = c / (COLS - 1), y = r / Math.max(1, rows - 1);
        // Fixed grain reads as material; low-frequency noise supplies the flow.
        const grain = 0.94 + hash2(c, r) * 0.12;
        let energy, color;
        if (audio) {
          const level = this.levels[c] * rows;
          const body = smooth(level - r);
          const crest = gauss(r + 0.5 - level, 0.65) * clamp(level);
          energy = body * (0.48 + y * 0.12) + crest * 0.22;
          const src = this.tracks[Math.floor(c / COLS * this.tracks.length)];
          const rgb = this.mode === 'capture' && src ? (src.live.cfg.muted ? MUTED_RGB : src.rgb) : RAMP[2];
          color = rgb.map((v, k) => INK[k] + (v - INK[k]) * clamp(energy * 1.55));
          // Ignition: a one-shot bottom-up accent sweep in the first 0.8 s of capture.
          if (this.mode === 'capture' && !reduced && age < 0.8) {
            const ig = age / 0.8;
            const band = gauss(y - (ig * 1.3 - 0.15), 0.18) * (1 - ig) * 0.4;
            energy = clamp(energy + band);
            color = color.map((v, k) => v + (RAMP[2][k] - v) * clamp(band * 1.4));
          }
        } else if (this.mode === 'paused') {
          const mid = Math.floor(rows / 2);
          const bars = (c === 3 || c === 4 || c === 7 || c === 8) && Math.abs(r - mid) <= Math.min(3, Math.floor(rows / 3));
          energy = bars ? 0.44 : gauss(y - 0.5, 0.23) * 0.035;
          color = INK.map((v, k) => v + (SAGE_RGB[k] - v) * energy * 1.7);
        } else {
          energy = this.mode === 'import' ? this._importField(x, y, t) : this._idleField(x, y, t);
          // Import wavefront: full currents below the progress line, a dim creep
          // shimmer above it, joined by a soft edge so the line never looks cut.
          if (this.mode === 'import' && this.importProgress != null) {
            const line = this.importProgress * 1.08;
            const edge = clamp((line - y) / 0.1 + 0.5);
            const creep = 0.05 + noise(x * 3, y * 5 - t * 0.06) * 0.03;
            energy = energy * edge + creep * (1 - edge);
          }
          energy = clamp(energy * grain);
          color = ramp(energy * 0.93);
        }
        // Reading current: directional streaks opposing the scroll, only while the
        // envelope is alive; decays back to exactly the plain field afterwards.
        if (this.scrollEnergy > 0.01 && (this.mode === 'idle' || this.mode === 'paused')) {
          const streak = noise(x * 2.6 + Math.sign(this.scrollPhase) * 3.7, y * 5.5 - this.scrollPhase * 3.1);
          energy = clamp(energy + streak * streak * this.scrollEnergy * 0.55);
        }
        // Chunk heartbeat + completion wash, shared across modes as overlays.
        let pulseE = 0, pulseRgb = null;
        for (const p of this.pulses) {
          const pa = this.clock - p.start;
          if (pa >= 0 && pa < PULSE_DUR) {
            pulseE += gauss(y - (pa / PULSE_DUR) * 1.3 - 0.15, 0.16) * (1 - pa / PULSE_DUR) * 0.5;
            pulseRgb = p.kind === 'error' ? RUST_RGB : MOSS_RGB;
          }
        }
        const sweepAge = this.clock - this.sweepAt;
        if (sweepAge >= 0 && sweepAge < SWEEP_DUR) {
          const sk = sweepAge / SWEEP_DUR;
          pulseE += gauss(y - (1.05 - sk * 1.3), 0.22) * Math.sin(sk * Math.PI) * 0.55;
          pulseRgb = pulseRgb || MOSS_RGB;
        }
        if (pulseE > 0.003) {
          energy = clamp(energy + pulseE * 0.5);
          color = color.map((v, k) => v + (pulseRgb[k] - v) * clamp(pulseE * 0.9));
        }
        this._tile(c * rows + r, gap + c * (cell + gap), top + (rows - 1 - r) * (cell + gap), cell, energy, color, blend, grain);
      }
    }
    ctx.globalAlpha = 1;
  }

  _idleField(x, y, t) {
    const tt = t % IDLE_TOTAL;
    let slot = 0;
    while (tt >= IDLE_STARTS[slot] + IDLE_SCHEDULE[slot].dwell) slot++;
    const local = tt - IDLE_STARTS[slot];
    const fade = smooth((local - (IDLE_SCHEDULE[slot].dwell - IDLE_FADE)) / IDLE_FADE);
    const current = IDLE_FIELDS[IDLE_SCHEDULE[slot].field](x, y, t);
    const next = IDLE_FIELDS[IDLE_SCHEDULE[(slot + 1) % IDLE_SCHEDULE.length].field](x, y, t);
    const texture = noise(x * 4 + t * 0.03, y * 6 - t * 0.045);
    return 0.035 + (current * (1 - fade) + next * fade) * (0.78 + texture * 0.35);
  }

  _importField(x, y, t) {
    const bend = Math.sin(x * 5.4 + t * 0.33) * 0.10 + (noise(x * 3, t * 0.13) - 0.5) * 0.12;
    let b = 0.055 + noise(x * 6, y * 8 - t * 0.2) * 0.055;
    // Head and tail remain outside the grid at wrap, so the current never pops.
    for (let i = 0; i < 3; i++) {
      const phase = (t * (0.115 + i * 0.021) + i * 0.61) % 2.0;
      const head = phase - 0.5 + bend;
      const envelope = smooth(phase / 0.25) * smooth((2 - phase) / 0.25);
      const ribbon = gauss(y - head, 0.095) * 0.40 + gauss(y - head + 0.12, 0.18) * 0.17;
      b += ribbon * envelope;
    }
    const filament = 0.5 + 0.5 * Math.sin(x * 12 + Math.sin(y * 6 - t * 0.5) * 1.8);
    return b * (0.78 + filament ** 5 * 0.32);
  }

  _readLevels(dt, reduced) {
    if (this.mode === 'playback' && this.analyser) this.analyser.getByteFrequencyData(this.spectrum);
    for (let c = 0; c < COLS; c++) {
      let target = 0;
      if (this.mode === 'capture') {
        const src = this.tracks[Math.floor(c / COLS * this.tracks.length)];
        if (src && !src.live.cfg.muted) target = clamp(Math.pow(Math.max(0, src.live.smooth || 0) * 7.5, 0.6));
      } else if (this.analyser && this.spectrum?.length) {
        // Log-spaced frequency bands expose speech detail without aliasing one
        // isolated FFT bin to a whole column. Average energy within each band.
        const usable = Math.max(1, Math.floor(this.spectrum.length * 0.72));
        const lo = Math.floor(Math.pow(usable, c / COLS)) - 1;
        const hi = Math.max(lo + 1, Math.floor(Math.pow(usable, (c + 1) / COLS)));
        let sum = 0;
        for (let i = lo; i < hi; i++) sum += (this.spectrum[i] / 255) ** 2;
        target = Math.sqrt(sum / (hi - lo));
      }
      const response = target > this.levels[c] ? 0.045 : 0.24;
      const mix = reduced ? 1 : 1 - Math.exp(-dt / response);
      this.levels[c] += (target - this.levels[c]) * mix;
    }
  }

  _tile(index, x, y, size, energy, color, blend, grain) {
    const { ctx, pixels } = this;
    const offset = index * 4;
    for (let k = 0; k < 3; k++) pixels[offset + k] += (color[k] - pixels[offset + k]) * blend;
    pixels[offset + 3] += (energy - pixels[offset + 3]) * blend;
    const b = clamp(pixels[offset + 3]);
    const rgb = `${Math.round(pixels[offset])},${Math.round(pixels[offset + 1])},${Math.round(pixels[offset + 2])}`;
    // Two restrained halos soften the seams; no per-tile filters/shadow blurs.
    if (b > 0.25) {
      ctx.fillStyle = `rgb(${rgb})`;
      ctx.globalAlpha = (b - 0.25) * 0.075;
      ctx.fillRect(x - 2, y - 2, size + 4, size + 4);
      ctx.globalAlpha *= 0.45;
      ctx.fillRect(x - 4, y - 4, size + 8, size + 8);
    }
    ctx.globalAlpha = 0.56 + b * 0.44;
    ctx.fillStyle = `rgb(${rgb})`;
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, Math.min(2.2, size * 0.13));
    ctx.fill();
    // A tiny lit lip and dark foot give each tile depth without plastic gloss.
    ctx.fillStyle = PAL.lip;
    ctx.globalAlpha = (0.02 + b * b * 0.22) * grain;
    ctx.fillRect(x + 2, y + 1, Math.max(0, size - 4), 0.7);
    ctx.fillStyle = PAL.foot;
    ctx.globalAlpha = 0.15;
    ctx.fillRect(x + 2, y + size - 1, Math.max(0, size - 4), 0.7);
  }
}

// Exposed for the test harness (tools/test-viz.js).
Visualizer.IDLE_SCHEDULE = IDLE_SCHEDULE;
