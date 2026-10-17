'use strict';
// Real Chromium checks for the visualizer's timing, accessibility, and modes.
// 1.5.2 contract: 24-column lattice, ~12 idle fields, randomized idle start
// phase per launch, finer (>= 6-stop) energy ramp. viz.js must expose
// IDLE_FIELDS and RAMP for this harness (like IDLE_SCHEDULE) and carry a
// per-instance idleOffset; the test reads COLS from instance state (levels).
// Run: node tools/test-viz.js [optional screenshot.png]
const fs = require('fs');
const path = require('path');
const os = require('os');

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1320, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
  try {
    const labels = ['Woven idle', 'Ripple idle', 'Transcribing', 'Paused', 'Live sources'];
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><style>
      body { margin:0; padding:24px; background:#131514; color:#a99e98; font:13px system-ui; display:flex; gap:18px }
      section { padding:12px; background:#1f201f; border:1px solid #454442; border-radius:8px }
      p { margin:0 0 14px } canvas { display:block; width:208px; height:600px }
      </style></head><body>${labels.map((label) => `<section><p>${label}</p><canvas width="208" height="600"></canvas></section>`).join('')}</body></html>`));
    // v1.5: viz.js imports './theme/themes.js', unresolvable from a data:-URL module.
    // Bundle the pair for the harness (themes.js itself imports nothing).
    const themesSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/theme/themes.js'), 'utf8');
    const vizSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/viz.js'), 'utf8')
      .replace(/import\s*\{[^}]*\}\s*from\s*'\.\/theme\/themes\.js';/, '');
    const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(themesSrc + '\n' + vizSrc, 'utf8').toString('base64');
    const results = await win.webContents.executeJavaScript(`(async () => {
      const { Visualizer } = await import(${JSON.stringify(moduleUrl)});
      // Hidden test windows report document.hidden. Override only the harness.
      Object.defineProperty(document, 'hidden', { configurable:true, value:false });
      const checks = [];
      const check = (name, passed) => { checks.push({ name, passed }); };
      const canvases = [...document.querySelectorAll('canvas')];
      const visuals = canvases.map((c) => new Visualizer(c));
      const [idle, ripple, importer, paused, capture] = visuals;
      const COLS = idle.levels.length; // 1.5.2: the lattice is 24 columns
      await new Promise(requestAnimationFrame);
      importer.setImport();
      paused.setPaused();
      const sources = [{ cfg:{label:'Mic',muted:false},smooth:0.085 }, { cfg:{label:'Desktop',muted:false},smooth:0.035 }];
      capture.setCapture(sources);
      for (let frame = 0; frame <= 240; frame++) visuals.forEach((v) => v.draw(frame * 1000 / 60));
      check('each mode renders finite, nonempty pixels', visuals.every((v) => [...v.pixels].every(Number.isFinite) && v.pixels.some((n, i) => i % 4 === 3 && n > 0.1)));
      check('independent sources have different levels', capture.levels[0] > capture.levels[COLS - 1] + 0.15);
      const saved = paused.canvas.toDataURL();
      for (let frame = 241; frame < 280; frame++) paused.draw(frame * 1000 / 60);
      check('paused state settles to a still frame', paused.canvas.toDataURL() === saved);

      // Compare equal wall-clock durations at 30 vs 60 fps, not frame counts.
      const a = new Visualizer(document.createElement('canvas'));
      const b = new Visualizer(document.createElement('canvas'));
      a.width = b.width = 208; a.height = b.height = 600;
      a.setImport(); b.setImport();
      for (let f = 0; f <= 120; f++) a.draw(f * 1000 / 30);
      for (let f = 0; f <= 240; f++) b.draw(f * 1000 / 60);
      const drift = Math.max(...a.pixels.map((v, i) => Math.abs(v - b.pixels[i])));
      check('30 and 60 fps preserve speed and phase', Math.abs(a.clock - b.clock) < 0.001 && drift < 2);
      const beforeHide = a.clock;
      Object.defineProperty(document, 'hidden', { configurable:true, value:true });
      a.draw(5000);
      Object.defineProperty(document, 'hidden', { configurable:true, value:false });
      a.draw(65000);
      check('hidden time does not jump the animation', Math.abs(a.clock - beforeHide) < 0.001);

      a.motionQuery = { matches:true, removeEventListener(){} };
      a.dirty = true;
      a.draw(65100);
      const still = a.canvas.toDataURL();
      a.draw(65200); a.draw(65300);
      check('reduced motion keeps decorative states still', a.canvas.toDataURL() === still);
      a.setCapture(sources);
      a.draw(65400);
      check('reduced motion retains essential audio feedback', a.levels[0] > 0.5);
      sources[0].cfg.muted = true;
      a.draw(65600);
      check('muted source shows zero audio level', a.levels[0] === 0);
      sources[0].cfg.muted = false;

      let analyserReads = 0;
      const analyser = { frequencyBinCount:32, getByteFrequencyData(s) { analyserReads++; s.fill(150); } };
      a.setPlayback(analyser); a.draw(65800);
      analyser.frequencyBinCount = 64;
      a.setPlayback(analyser); a.draw(66000);
      check('playback analyser can change FFT size', a.spectrum.length === 64 && analyserReads === 2 && a.levels.every(Number.isFinite));
      a.setPaused(); a.draw(66100);
      check('paused never polls audio analyser', analyserReads === 2);
      a.destroy(); b.destroy();

      // Jump 24 s into the cycle to land on a later idle slot before the perf pass.
      ripple.clock = 24; ripple.lastFrame = null; ripple.dirty = true;
      for (let frame = 0; frame <= 60; frame++) ripple.draw(5000 + frame * 1000 / 60);
      const start = performance.now();
      for (let frame = 241; frame <= 480; frame++) importer.draw(frame * 1000 / 60);
      const averageFrameMs = (performance.now() - start) / 240;
      check('frame work remains below 16 ms budget', averageFrameMs < 16);

      // ---- v1.2 additions (docs/v1.2-animations.md §6) ----
      // Every idle schedule slot — sampled mid-dwell AND mid-crossfade — renders
      // finite, lit pixels.
      const sched = Visualizer.IDLE_SCHEDULE;
      const starts = []; let acc = 0;
      for (const s of sched) { starts.push(acc); acc += s.dwell; }
      let slotsOk = true;
      for (let i = 0; i < sched.length; i++) {
        for (const at of [starts[i] + sched[i].dwell * 0.5, starts[i] + sched[i].dwell - 2]) {
          idle.clock = at; idle.lastFrame = null; idle.dirty = true;
          for (let f = 0; f <= 20; f++) idle.draw(700000 + f * 1000 / 60);
          slotsOk = slotsOk && [...idle.pixels].every(Number.isFinite)
            && idle.pixels.some((n, j) => j % 4 === 3 && n > 0.05);
        }
      }
      check('all idle fields render finite, lit pixels (incl. crossfades)', slotsOk);

      // Reading current: scroll energy changes the frame, then fully releases.
      const s1 = new Visualizer(document.createElement('canvas'));
      const s2 = new Visualizer(document.createElement('canvas'));
      s1.width = s2.width = 208; s1.height = s2.height = 600;
      s2.idleOffset = s1.idleOffset; // share the base field so the check isolates the scroll transient
      s1.setScrollVelocity(700);
      for (let f = 0; f <= 60; f++) { s1.draw(900000 + f * 1000 / 60); s2.draw(900000 + f * 1000 / 60); }
      check('scroll energy changes the idle frame', s1.canvas.toDataURL() !== s2.canvas.toDataURL());
      s1.setScrollVelocity(0);
      for (let f = 61; f <= 360; f++) { s1.draw(900000 + f * 1000 / 60); s2.draw(900000 + f * 1000 / 60); }
      const scrollResidue = Math.max(...s1.pixels.map((vv, i) => Math.abs(vv - s2.pixels[i])));
      check('scroll energy fully releases (no residue)', scrollResidue < 0.5);

      // Reduced motion: scroll input must produce zero delta.
      const rm = new Visualizer(document.createElement('canvas'));
      rm.width = 208; rm.height = 600;
      rm.motionQuery = { matches: true, removeEventListener() {} };
      for (let f = 0; f <= 30; f++) rm.draw(940000 + f * 1000 / 60);
      const rmStill = [...rm.pixels];
      rm.setScrollVelocity(800);
      for (let f = 31; f <= 60; f++) rm.draw(940000 + f * 1000 / 60);
      check('reduced motion ignores scroll input', rm.pixels.every((vv, i) => vv === rmStill[i]));

      // Import wavefront: below the progress line is brighter than above it.
      const iw = new Visualizer(document.createElement('canvas'));
      iw.width = 208; iw.height = 600;
      iw.setImport(0.5);
      for (let f = 0; f <= 60; f++) iw.draw(950000 + f * 1000 / 60);
      const irows = iw.grid.rows;
      let below = 0, above = 0;
      for (let r = 0; r < irows; r++) {
        const yNorm = r / Math.max(1, irows - 1);
        let sum = 0;
        for (let c = 0; c < COLS; c++) sum += iw.pixels[(c * irows + r) * 4 + 3];
        if (yNorm < 0.35) below += sum; else if (yNorm > 0.7) above += sum;
      }
      check('import wavefront fills from the bottom', below > above * 1.5);
      iw.setImport();
      for (let f = 61; f <= 90; f++) iw.draw(950000 + f * 1000 / 60);
      check('setImport() without progress keeps classic behavior', [...iw.pixels].every(Number.isFinite));

      // Chunk pulse: transient perturbation that decays cleanly. The idle field
      // itself animates, so decay is judged against a pulse-free twin drawn at
      // identical clock times — never against an earlier snapshot.
      const pw = new Visualizer(document.createElement('canvas'));
      const pw2 = new Visualizer(document.createElement('canvas'));
      pw.width = pw2.width = 208; pw.height = pw2.height = 600;
      pw2.idleOffset = pw.idleOffset; // share the base field so the check isolates the pulse transient
      for (let f = 0; f <= 150; f++) { pw.draw(970000 + f * 1000 / 60); pw2.draw(970000 + f * 1000 / 60); }
      pw.pulse('done');
      for (let f = 151; f <= 180; f++) { pw.draw(970000 + f * 1000 / 60); pw2.draw(970000 + f * 1000 / 60); }
      check('chunk pulse perturbs the grid', Math.max(...pw.pixels.map((vv, i) => Math.abs(vv - pw2.pixels[i]))) > 0.05);
      for (let f = 181; f <= 540; f++) { pw.draw(970000 + f * 1000 / 60); pw2.draw(970000 + f * 1000 / 60); }
      check('chunk pulse decays cleanly', Math.max(...pw.pixels.map((vv, i) => Math.abs(vv - pw2.pixels[i]))) < 0.5);

      // Completion sweep: transient top-to-bottom wash that decays cleanly.
      const sw = new Visualizer(document.createElement('canvas'));
      const sw2 = new Visualizer(document.createElement('canvas'));
      sw.width = sw2.width = 208; sw.height = sw2.height = 600;
      sw2.idleOffset = sw.idleOffset; // share the base field so the check isolates the sweep transient
      for (let f = 0; f <= 150; f++) { sw.draw(980000 + f * 1000 / 60); sw2.draw(980000 + f * 1000 / 60); }
      sw.sweep();
      for (let f = 151; f <= 180; f++) { sw.draw(980000 + f * 1000 / 60); sw2.draw(980000 + f * 1000 / 60); }
      check('completion sweep perturbs the grid', Math.max(...sw.pixels.map((vv, i) => Math.abs(vv - sw2.pixels[i]))) > 0.05);
      for (let f = 181; f <= 540; f++) { sw.draw(980000 + f * 1000 / 60); sw2.draw(980000 + f * 1000 / 60); }
      check('completion sweep decays cleanly', Math.max(...sw.pixels.map((vv, i) => Math.abs(vv - sw2.pixels[i]))) < 0.5);

      // ---- v1.5.2 additions (grid redesign: 24 cols, ~12 fields, randomized
      // idle start, finer ramp). Contracts asserted here are what viz.js must
      // expose: COLS via instance state, plus IDLE_FIELDS / RAMP on the class.
      check('lattice is 24 columns', COLS === 24);
      const ramp = Visualizer.RAMP || [];
      check('energy ramp is finer than the 4-stop v1.5 ramp', ramp.length >= 6
        && ramp.every((s) => Array.isArray(s) && s.length === 3 && s.every(Number.isFinite)));
      const fields = Visualizer.IDLE_FIELDS || [];
      check('idle field set is ~12 fields', fields.length >= 11 && fields.length <= 12);
      const slots = Visualizer.IDLE_SCHEDULE || [];
      check('schedule gives every idle field exactly one slot', slots.length === fields.length
        && new Set(slots.map((s) => s.field)).size === slots.length
        && slots.every((s) => Number.isInteger(s.field) && s.field >= 0 && s.field < fields.length));
      check('no field dissolves into itself (incl. wrap)', slots.length > 1 && slots.every((s, i) => s.field !== slots[(i + 1) % slots.length].field));

      // Field purity: each field is a pure, finite function of (x, y, t).
      // Sampled on a fixed seed grid; identical args must give bit-identical
      // results (hash-seeded, no hidden state, no frame-count dependence).
      const seeds = [];
      for (const [sx, sy] of [[0.15, 0.3], [0.5, 0.5], [0.85, 0.7], [0.3, 0.9]]) for (const st of [1, 40, 99]) seeds.push([sx, sy, st]);
      let pure = fields.length > 0;
      for (const f of fields) for (const [x, y, t] of seeds) {
        const v = f(x, y, t);
        if (!Number.isFinite(v) || f(x, y, t) !== v) pure = false;
      }
      check('idle fields are pure, finite functions of (x,y,t)', pure);

      // Randomized launch: fresh instances get distinct schedule phases in
      // [0, total) — no two opens start the same.
      const total = (typeof Visualizer.IDLE_TOTAL === 'number' && Visualizer.IDLE_TOTAL > 0)
        ? Visualizer.IDLE_TOTAL : (slots.reduce((s, f) => s + f.dwell, 0) || 1);
      const spawns = [0, 1, 2, 3].map(() => new Visualizer(document.createElement('canvas')));
      const offs = spawns.map((v) => v.idleOffset);
      check('idle start phase is randomized per launch', offs.every((o) => Number.isFinite(o) && o >= 0 && o < total) && new Set(offs).size > 1);

      // The offset must be applied, not just stored: identical offset + clock
      // is fully deterministic (seeded purity), a different offset renders a
      // different frame.
      const z1 = new Visualizer(document.createElement('canvas'));
      const z2 = new Visualizer(document.createElement('canvas'));
      const z3 = new Visualizer(document.createElement('canvas'));
      z1.width = z2.width = z3.width = 208; z1.height = z2.height = z3.height = 600;
      z1.idleOffset = 0; z2.idleOffset = 0; z3.idleOffset = total / 2;
      for (let f = 0; f <= 90; f++) { z1.draw(1e6 + f * 1000 / 60); z2.draw(1e6 + f * 1000 / 60); z3.draw(1e6 + f * 1000 / 60); }
      check('fixed offset + clock is fully deterministic', z1.pixels.every((v, i) => v === z2.pixels[i]));
      check('different idle offsets render different frames', Math.max(...z1.pixels.map((v, i) => Math.abs(v - z3.pixels[i]))) > 0.01);
      spawns.forEach((v) => v.destroy()); z1.destroy(); z2.destroy(); z3.destroy();

      // Perf with the reading current active. 1.5.2 doubles the tile count
      // (24 cols), so the budget is the 16 ms 60 fps floor, not the old 8 ms
      // micro-budget that fit the 12-column grid.
      const pf = new Visualizer(document.createElement('canvas'));
      pf.width = 208; pf.height = 600;
      pf.setScrollVelocity(500);
      const t0 = performance.now();
      for (let f = 0; f <= 300; f++) pf.draw(990000 + f * 1000 / 60);
      const scrollFrameMs = (performance.now() - t0) / 300;
      check('scroll-active frames remain under the 16 ms budget', scrollFrameMs < 16);
      s1.destroy(); s2.destroy(); iw.destroy(); pw.destroy(); pw2.destroy(); sw.destroy(); sw2.destroy(); pf.destroy();

      window.visuals = visuals;
      return { checks, drift, averageFrameMs, canvasSize: [idle.canvas.width, idle.canvas.height] };
    })()`);
    for (const check of results.checks) console.log(`${check.passed ? 'ok' : 'FAIL'}  ${check.name}`);
    console.log(`30/60 fps max channel difference: ${results.drift.toFixed(3)}; average frame: ${results.averageFrameMs.toFixed(2)} ms`);
    const screenshot = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'susurro-visualizer.png'));
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    console.log(`Screenshot: ${screenshot}`);
    app.exit(results.checks.every((c) => c.passed) ? 0 : 1);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
