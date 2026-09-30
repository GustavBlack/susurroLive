'use strict';
/**
 * Diarization IPC test: the REAL main process + preload bridge in an invisible window, with
 * the diarizer sidecar and whisper stubbed (no native binaries, no model).
 *   node tools/test-diarize-ipc.js
 *
 * Asserts the Task 3 contract: guards, results written to the session they were started for
 * (even after switching sessions mid-run), events reaching the renderer through the preload
 * whitelist, derived wordSpeakers aligned with words, and auto-run firing when transcription
 * goes idle - not when Stop/Import returns.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.join(__dirname, '..');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: repo, env, stdio: 'inherit', windowsHide: true });
  const timeout = setTimeout(() => { console.error('Diarize IPC test timed out'); child.kill(); }, 58000);
  child.once('error', (error) => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
  child.once('exit', (code) => { clearTimeout(timeout); process.exitCode = code === 0 ? 0 : 1; });
} else {
  runElectron().catch((error) => {
    console.error(error.stack || error);
    require('electron').app.exit(1);
  });
}

async function runElectron() {
  const electron = require('electron');
  const { app, ipcMain } = electron;
  const Module = require('node:module');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-diarize-ipc-'));
  const userData = path.join(root, 'user-data');
  const sessions = path.join(root, 'sessions');
  for (const directory of [userData, sessions]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    lastSessionParent: sessions, chunkSec: 60, showGpuBanner: false, lastSources: [],
  }));
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  const watchdog = setTimeout(() => { console.error('Diarize IPC watchdog expired'); app.exit(1); }, 55000);

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

  // ---- stubs: whisper (slow enough to observe "not yet idle") and the diarizer ----
  const { Engine } = require('../src/main/whisper');
  Engine.prototype.transcribe = async function(_audioPath, options) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { engine: 'test-synthetic', language: 'en', words: [{ t: 0.1, d: 0.4, w: `Word${options.chunkIndex}` }], text: 'w' };
  };
  const diarizer = require('../src/main/diarizer');
  const calls = [];
  let gate = null;          // when set, runDiarize waits for gate.promise
  let nextResult = null;    // one-shot override (e.g. a failure)
  diarizer.status = () => ({ available: true, binary: 'stub', model: 'stub-model', reason: null });
  diarizer.runDiarize = async ({ session }) => {
    calls.push(session.folder);
    if (gate) await gate.promise;
    const r = nextResult;
    nextResult = null;
    return r || {
      ok: true, engine: 'stub', model: 'stub-model', audioSec: 3, ms: 1,
      turns: [{ start: 0, end: 1.0, speaker: 2 }, { start: 1.2, end: 3, speaker: 1 }],
    };
  };
  const hold = () => { let release; gate = { promise: new Promise((r) => { release = r; }) }; return () => { const g = gate; gate = null; release(); return g; }; };

  const store = require('../src/main/session');
  const makeSession = (name, { pending = false } = {}) => {
    const s = store.createSession({ parentDir: sessions, name, settings: {}, gpu: null, chunkSec: 30 });
    s.chunks = [{
      index: 0, offsetSec: 0, durationSec: 3, audioFile: 'audio/chunk_0000.wav', status: pending ? 'pending' : 'done',
      words: pending ? [] : [{ t: 0.2, d: 0.3, w: 'Hello' }, { t: 1.5, d: 0.3, w: 'there' }, { t: 2.4, d: 0.3, w: 'friend.' }],
    }];
    store.writeSession(s.folder, s);
    return s.folder;
  };
  const readFile = (folder) => JSON.parse(fs.readFileSync(path.join(folder, 'session.json'), 'utf8'));

  const ready = new Promise((resolve) => ipcMain.once('app:ready', resolve));
  require(mainPath);
  Module._load = originalLoad;
  await ready;

  const js = (source) => win.webContents.executeJavaScript(source, true);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (name, fn, timeoutMs = 8000) => {
    const end = Date.now() + timeoutMs;
    do { if (await fn()) return; await delay(50); } while (Date.now() < end);
    throw new Error(`Timed out: ${name}`);
  };
  const check = (name, value, detail) => { assert.ok(value, `${name}${detail ? ` (${detail})` : ''}`); console.log(`  ok    ${name}`); };
  const events = () => js('window.__diarEvents');

  await js(`(() => {
    window.__diarEvents = [];
    for (const evt of ['diarizeProgress', 'diarizeDone', 'diarizeError']) {
      window.susurro.on(evt, (p) => window.__diarEvents.push({ evt, ...p }));
    }
  })()`);

  console.log('\n=== guards ===');
  check('bridge exposes diarize.run/status', await js('typeof window.susurro.diarize?.run === "function" && typeof window.susurro.diarize?.status === "function"'));
  check('status passes through main', (await js('window.susurro.diarize.status()')).available === true);
  await js('window.susurro.session.close()');
  const none = await js('window.susurro.diarize.run()');
  check('no session -> refused', none.ok === false && /no session/.test(none.error), none.error);

  const pendingFolder = makeSession('Pending', { pending: true });
  await js(`window.susurro.session.open(${JSON.stringify(pendingFolder)})`);
  const busy = await js('window.susurro.diarize.run()');
  check('transcription outstanding -> refused', busy.ok === false && /transcription/.test(busy.error), busy.error);
  check('refusals never reached the sidecar', calls.length === 0);

  console.log('\n=== happy path ===');
  const folderA = makeSession('Alpha');
  await js(`window.susurro.session.open(${JSON.stringify(folderA)})`);
  const done = await js('window.susurro.diarize.run()');
  check('run resolves ok', done.ok === true && done.speakers === 2, JSON.stringify(done));
  const fileA = readFile(folderA);
  check('block persisted in session.json', fileA.diarization?.turns?.length === 2 && fileA.diarization.speakers === 2);
  check('turns relabelled by arrival (raw 2 -> spk0)', fileA.diarization.turns[0].speaker === 'spk0');
  check('schema version untouched', fileA.version === 1);
  const cur = await js('window.susurro.session.current()');
  check('wordSpeakers aligned with words', cur.wordSpeakers?.length === cur.transcript.words.length,
    `${cur.wordSpeakers?.length}/${cur.transcript.words.length}`);
  check('wordSpeakers derived by the join rule', JSON.stringify(cur.wordSpeakers) === JSON.stringify(['spk0', 'spk1', 'spk1']),
    JSON.stringify(cur.wordSpeakers));
  await until('diarizeDone event', async () => (await events()).some((e) => e.evt === 'diarizeDone'));
  const ev = await events();
  check('progress then done reached the renderer (preload whitelist)',
    ev[0]?.evt === 'diarizeProgress' && ev[0].pct === null && ev.some((e) => e.evt === 'diarizeDone' && e.folder === folderA));

  console.log('\n=== one run at a time ===');
  const n = calls.length;
  let release = hold();
  await js('(window.__run1 = window.susurro.diarize.run(), true)');
  await until('first run reached the sidecar', () => calls.length === n + 1);
  const second = await js('window.susurro.diarize.run()');
  check('second run refused while one is in flight', second.ok === false && /already running/.test(second.error), second.error);
  check('status reports the running folder', (await js('window.susurro.diarize.status()')).running === folderA);
  release();
  check('first run still completes', (await js('window.__run1')).ok === true);

  console.log('\n=== switching sessions mid-run ===');
  const folderB = makeSession('Bravo');
  const blockA = JSON.stringify(readFile(folderA).diarization);
  // run on B, then switch to A before the sidecar finishes
  await js(`window.susurro.session.open(${JSON.stringify(folderB)})`);
  release = hold();
  await js('(window.__runB = window.susurro.diarize.run(), true)');
  await until('B run reached the sidecar', () => calls[calls.length - 1] === folderB);
  await js(`window.susurro.session.open(${JSON.stringify(folderA)})`);
  release();
  check('B run completes', (await js('window.__runB')).ok === true);
  check('result landed in B (the folder it was started for)', readFile(folderB).diarization?.turns?.length === 2);
  check('active session A untouched', JSON.stringify(readFile(folderA).diarization) === blockA);
  check('active session A in memory untouched', JSON.stringify((await js('window.susurro.session.current()')).diarization) === blockA);

  // same folder re-opened mid-run: the in-memory copy must receive it, or the next persist loses it
  const folderC = makeSession('Charlie');
  await js(`window.susurro.session.open(${JSON.stringify(folderC)})`);
  release = hold();
  await js('(window.__runC = window.susurro.diarize.run(), true)');
  await until('C run reached the sidecar', () => calls[calls.length - 1] === folderC);
  await js(`window.susurro.session.open(${JSON.stringify(folderB)})`);
  await js(`window.susurro.session.open(${JSON.stringify(folderC)})`);
  release();
  await js('window.__runC');
  check('re-opened session gets the block in memory', (await js('window.susurro.session.current()')).diarization?.turns?.length === 2);
  await js('window.susurro.session.rename("Charlie renamed")'); // forces a persist of the active session
  check('...and a later save keeps it', readFile(folderC).diarization?.turns?.length === 2 && readFile(folderC).name === 'Charlie renamed');

  console.log('\n=== cancel ===');
  const beforeCancel = JSON.stringify(readFile(folderC).diarization);
  check('cancel with nothing running is refused', (await js('window.susurro.diarize.cancel()')).ok === false);
  release = hold();
  await js('(window.__runX = window.susurro.diarize.run(), true)');
  await until('run to cancel reached the sidecar', () => calls[calls.length - 1] === folderC);
  check('cancel accepted while running', (await js('window.susurro.diarize.cancel()')).ok === true);
  release();
  const cancelled = await js('window.__runX');
  check('cancelled run resolves {cancelled:true}', cancelled.ok === false && cancelled.cancelled === true);
  check('cancelled run saves nothing', JSON.stringify(readFile(folderC).diarization) === beforeCancel);
  await until('cancel event', async () => (await events()).some((e) => e.evt === 'diarizeError' && e.cancelled));

  console.log('\n=== failure ===');
  nextResult = { ok: false, error: 'boom from the sidecar' };
  const failed = await js('window.susurro.diarize.run()');
  check('failure resolves ok:false', failed.ok === false && /boom/.test(failed.error));
  await until('diarizeError event', async () => (await events()).some((e) => e.evt === 'diarizeError'));
  check('error event names the folder', (await events()).find((e) => e.evt === 'diarizeError').folder === folderC);
  check('previous block kept on failure', readFile(folderC).diarization?.turns?.length === 2);

  console.log('\n=== auto-run waits for transcription ===');
  const { WavWriter } = require('../src/main/wav');
  const media = path.join(root, 'two-chunks.wav');
  const w = new WavWriter(media, { sampleRate: 48000 }).open();
  w.write(Buffer.alloc(48000 * 2 * 65));   // 65 s of silence -> 2 chunks at chunkSec 60
  w.close();
  await js('window.susurro.settings.set({ diarizeAutoOnStop: true })');
  const before = calls.length;
  const imported = await js(`window.susurro.import.run({ mediaPath: ${JSON.stringify(media)} })`);
  if (!imported.ok && /ffmpeg/.test(imported.error || '')) {
    console.log('  SKIP  auto-run (no ffmpeg in native/bin)');
  } else {
    check('import ok', imported.ok === true, imported.error);
    check('no diarize while chunks are still transcribing', calls.length === before);
    await until('auto-run after the pipeline went idle', () => calls.length === before + 1, 15000);
    const importedFolder = imported.session.folder;
    check('auto-run targeted the imported session', calls[calls.length - 1] === importedFolder);
    await until('auto-run saved', () => !!readFile(importedFolder).diarization, 5000);
    check('auto-run fired exactly once', calls.length === before + 1);
  }

  clearTimeout(watchdog);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('\nDIARIZE IPC: PASS');
  app.exit(0);
}
