'use strict';
/**
 * End-to-end speaker identification with the REAL sidecars (whisper + nemo-speech), no stubs.
 *   node tools/test-diarize-e2e.js [media.wav]
 *
 * Imports a multi-voice recording with "identify speakers automatically" on, waits for
 * transcription and the auto-run, then reads the actual UI: speaker chips, legend, button.
 * Skips (exit 0) when native/bin/diarizer or its model is missing - run `npm run native:diarizer`.
 * Default media: SUSURRO_DIAR_FIXTURE, a WAV with at least two distinct voices.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.join(__dirname, '..');

if (!process.versions.electron) {
  const diarizer = require('../src/main/diarizer');
  const st = diarizer.status({ repoRoot: repo, binDir: path.join(repo, 'native', 'bin'), modelDir: path.join(repo, 'native', 'models') });
  const media = process.argv[2] || process.env.SUSURRO_DIAR_FIXTURE;
  if (!st.available) { console.log(`SKIP  ${st.reason}`); process.exit(0); }
  if (!media || !fs.existsSync(media)) { console.log('SKIP  pass a multi-voice WAV (arg or SUSURRO_DIAR_FIXTURE)'); process.exit(0); }
  const { spawn } = require('node:child_process');
  const env = { ...process.env, SUSURRO_DIAR_FIXTURE: path.resolve(media) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: repo, env, stdio: 'inherit', windowsHide: true });
  const timeout = setTimeout(() => { console.error('E2E timed out'); child.kill(); }, 590000);
  child.once('exit', (code) => { clearTimeout(timeout); process.exitCode = code === 0 ? 0 : 1; });
} else {
  run().catch((error) => { console.error(error.stack || error); require('electron').app.exit(1); });
}

async function run() {
  const electron = require('electron');
  const { app, ipcMain } = electron;
  const Module = require('node:module');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-diarize-e2e-'));
  const userData = path.join(root, 'user-data');
  const sessions = path.join(root, 'sessions');
  for (const d of [userData, sessions]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    lastSessionParent: sessions, chunkSec: 30, showGpuBanner: false, lastSources: [], model: 'small.en',
    diarizeAutoOnStop: true,
  }));
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  const watchdog = setTimeout(() => { console.error('E2E watchdog expired'); app.exit(1); }, 580000);

  let win;
  class InvisibleWindow extends electron.BrowserWindow {
    constructor(options) {
      super({ ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
      win = this;
    }
  }
  const mainPath = path.join(repo, 'src', 'main', 'index.js');
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron' && parent?.filename === mainPath) return { ...electron, BrowserWindow: InvisibleWindow };
    return originalLoad.call(this, request, parent, isMain);
  };
  const ready = new Promise((resolve) => ipcMain.once('app:ready', resolve));
  require(mainPath);
  Module._load = originalLoad;
  await ready;

  const js = (source) => win.webContents.executeJavaScript(source, true);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (name, value, detail) => { assert.ok(value, `${name}${detail ? ` (${detail})` : ''}`); console.log(`  ok    ${name}${detail ? `   ${detail}` : ''}`); };

  await js(`(() => { window.__done = null; window.susurro.on('diarizeDone', (p) => { window.__done = p; });
    window.susurro.on('diarizeError', (p) => { window.__done = { error: p.error }; }); })()`);
  const t0 = Date.now();
  const imported = await js(`window.susurro.import.run({ mediaPath: ${JSON.stringify(process.env.SUSURRO_DIAR_FIXTURE)} })`);
  check('import ok', imported.ok, imported.error);
  let done = null;
  for (let i = 0; i < 1100 && !done; i++) { await delay(500); done = await js('window.__done'); }
  check('auto-run finished', done && !done.error, JSON.stringify(done));
  console.log(`  ..    transcription + speakers in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await delay(800);

  const ui = await js(`({
    chips: document.querySelectorAll('#transcript .spk-chip').length,
    labelled: document.querySelectorAll('#transcript .w[data-spk]').length,
    words: document.querySelectorAll('#transcript .w').length,
    legend: [...document.querySelectorAll('#spkLegend .spk-key')].map((k) => k.textContent),
    legendHidden: document.getElementById('spkLegend').classList.contains('hidden'),
    button: document.getElementById('btnDiarize').textContent,
    error: window.__err,
  })`);
  const file = JSON.parse(fs.readFileSync(path.join(imported.session.folder, 'session.json'), 'utf8'));
  check('session.json has turns from the real diarizer', file.diarization?.turns?.length > 0 && !/test|demo/.test(file.diarization.engine),
    `${file.diarization?.speakers} speakers, ${file.diarization?.turns?.length} turns, ${file.diarization?.engine}`);
  check('more than one speaker found', done.speakers >= 2, `${done.speakers}`);
  check('legend lists every speaker', !ui.legendHidden && ui.legend.length === done.speakers, ui.legend.join(' · '));
  check('chips mark the turns', ui.chips >= done.speakers, `${ui.chips} chips`);
  check('almost every word labelled', ui.labelled >= ui.words * 0.95, `${ui.labelled}/${ui.words}`);
  check('button offers a re-run', /Speakers/.test(ui.button), ui.button);
  check('no page errors', !ui.error, ui.error);

  clearTimeout(watchdog);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('\nDIARIZE E2E: PASS');
  app.exit(0);
}
