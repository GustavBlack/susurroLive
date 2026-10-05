'use strict';
/**
 * Run: node tools/test-record-ui.js
 * Real Electron renderer, preload bridge, capture graph, recorder, pipeline and WAV.
 * Uses isolated settings/session files and oscillator audio; never opens a microphone.
 * Only ASR is replaced with deterministic text for this synthetic signal.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const repo = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], {
    cwd: repo, env, stdio: 'inherit', windowsHide: true,
  });
  const timeout = setTimeout(() => { console.error('Record UI test timed out'); child.kill(); }, 58000);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-record-ui-'));
  const userData = path.join(root, 'user-data');
  const sessions = path.join(root, 'sessions');
  const shots = path.join(root, 'screenshots');
  for (const directory of [userData, sessions, shots]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    lastSessionParent: sessions, chunkSec: 60, showGpuBanner: false, lastSources: [],
  }));
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  const watchdog = setTimeout(() => { console.error('Record UI watchdog expired'); app.exit(1); }, 55000);
  let win;
  const pageErrors = [];
  class InvisibleWindow extends electron.BrowserWindow {
    constructor(options) {
      super({ ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false, offscreen: true } });
      win = this;
      this.webContents.on('console-message', (event) => {
        if (event.level === 'error') pageErrors.push(event.message);
      });
      this.webContents.on('render-process-gone', (_event, details) => pageErrors.push(`renderer gone: ${details.reason}`));
    }
  }
  const mainPath = path.join(repo, 'src', 'main', 'index.js');
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron' && parent?.filename === mainPath) {
      return { ...electron, BrowserWindow: InvisibleWindow };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const { Engine } = require('../src/main/whisper');
  let asrCalls = 0;
  Engine.prototype.transcribe = async function(audioPath, options) {
    assert.ok(path.resolve(audioPath).startsWith(sessions + path.sep), 'ASR stub must only read this fixture');
    asrCalls++;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const word = `Pass${options.chunkIndex + 1}`;
    return { engine: 'test-synthetic', language: 'en', words: [{ t: 0.1, d: 0.4, w: word }], text: word };
  };

  const ready = new Promise((resolve) => ipcMain.once('app:ready', resolve));
  require(mainPath);
  Module._load = originalLoad;
  await ready;
  assert.ok(win && !win.isVisible(), 'test window remains invisible');
  const js = (source) => win.webContents.executeJavaScript(source, true);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const poll = async (name, source, timeoutMs = 6000) => {
    const end = Date.now() + timeoutMs;
    do {
      if (await js(source)) return;
      await delay(50);
    } while (Date.now() < end);
    throw new Error(`Timed out: ${name}; UI: ${JSON.stringify(await ui())}`);
  };
  const ui = () => js(`({
    endHidden: document.getElementById('btnEndSession').classList.contains('hidden'),
    endDisabled: document.getElementById('btnEndSession').disabled,
    confirmHidden: document.getElementById('endConfirm').classList.contains('hidden'),
    recordTitle: document.getElementById('btnRecord').title,
    recordDisabled: document.getElementById('btnRecord').disabled,
    recording: document.getElementById('btnRecord').classList.contains('recording'),
    paused: document.getElementById('btnRecord').classList.contains('paused'),
    status: document.getElementById('statusPill').textContent,
    timer: document.getElementById('timer').textContent,
    sub: document.getElementById('recSub').textContent,
    toast: document.getElementById('toast').textContent,
    error: window.__err
  })`);
  const current = () => js('window.susurro.session.current()');
  const click = (id) => js(`document.getElementById(${JSON.stringify(id)}).click()`);
  const capture = async (name) => {
    // Force a compositor update: otherwise a hidden window may return its previous surface.
    win.webContents.invalidate();
    await delay(350);
    const output = path.join(shots, `${name}.png`);
    fs.writeFileSync(output, (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    console.log(`SCREENSHOT: ${output}`);
  };
  const check = (name, value) => { assert.ok(value, name); console.log(`  ok    ${name}`); };
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  check('fresh app hides END SESSION', (await ui()).endHidden && (await ui()).confirmHidden);
  check('isolated preferences are active', (await js('window.susurro.app.paths()')).userData === userData);

  // Inject after the real app signals readiness; no native input is ever requested.
  await js(`(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    window.__testAudio = [];
    window.__testGetUserMediaCalls = 0;
    window.__testEvents = [];
    window.susurro.on('recordState', (state) => window.__testEvents.push(state));
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => [
      { kind: 'audioinput', deviceId: 'synthetic-mic', groupId: 'test', label: 'Synthetic test microphone' }
    ] });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      window.__testGetUserMediaCalls++;
      const context = new AudioContext({ sampleRate: 48000 });
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 220;
      const gain = context.createGain();
      gain.gain.value = 0.2;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain); gain.connect(destination); oscillator.start();
      await context.resume();
      window.__testAudio.push({ context, oscillator, stream: destination.stream });
      return destination.stream;
    } });
    document.getElementById('sessionName').value = 'Pause resume regression';
  })()`);
  // v1.5.1: recording without a session arms the guided New-session attention.
  await click('btnRecord');
  await poll('record without a session opens the browser', `!document.getElementById('sessionModal').classList.contains('hidden')`);
  check('guided new-session attention armed', await js(`document.getElementById('btnNewSession').classList.contains('cta')`));
  await capture('00-record-blocked-attention');
  await click('btnNewSession');
  await poll('session created', `document.getElementById('folderPath').textContent.includes('Pause-resume-regression')`);
  check('guided attention cleared after create', await js(`document.getElementById('sessionModal').classList.contains('hidden')`)
    && await js(`!document.getElementById('btnNewSession').classList.contains('cta')`));
  const initial = await current();
  await click('btnAddMic');
  await poll('mock microphone added', `document.querySelectorAll('.src-row').length === 1`);
  await click('btnRecord');
  await poll('recording started', `document.getElementById('btnRecord').classList.contains('recording') && document.getElementById('btnEndSession').classList.contains('hidden')`);
  await poll('capturing PCM and timer advancing', `document.getElementById('timer').textContent !== '00:00'`);
  check('record button offers pause; no end path while recording', (await ui()).recordTitle === 'Pause recording' && (await ui()).endHidden && (await ui()).confirmHidden);
  await poll('record button morphed into labelled square', `parseFloat(getComputedStyle(document.getElementById('btnRecord')).width) > 70`);
  await capture('01-recording');

  const firstPause = async () => {
    await click('btnRecord');
    await poll('paused UI', `document.getElementById('btnRecord').classList.contains('paused') && !document.getElementById('btnEndSession').classList.contains('hidden')`);
    await poll('partial chunk transcribed', `(async () => (await window.susurro.session.current()).chunks.every(c => c.status === 'done'))()`);
  };
  await firstPause();
  await delay(2300); // inspect the settled paused grid, after its transition
  check('record button shows written Resume when paused', await js(`document.querySelector('#btnRecord .rec-label').textContent === 'Resume'
    && parseFloat(getComputedStyle(document.getElementById('btnRecord')).width) > 70`));
  await capture('02-paused');
  const paused = await current();
  const frozenUi = await ui();
  const files = paused.chunks.map((chunk) => path.join(paused.folder, chunk.audioFile));
  const fileHashes = files.map(hash);
  await js(`window.susurro.capture.pcm(new Int16Array(96000).fill(32767).buffer)`);
  await delay(1250);
  const stillPaused = await current();
  check('timer freezes while paused', (await ui()).timer === frozenUi.timer);
  check('main discards PCM sent directly while paused', stillPaused.recording.durationSec === paused.recording.durationSec &&
    stillPaused.chunks.length === paused.chunks.length && files.every((file, i) => hash(file) === fileHashes[i]));
  check('paused state keeps same active session', stillPaused.id === initial.id && (await ui()).status === 'Paused');
  check('pause disabled microphone tracks', await js('window.__testAudio.every(a => a.stream.getAudioTracks().every(t => !t.enabled))'));
  check('partial chunk produced transcript during pause', paused.transcript.words.length > 0);
  check('duplicate Pause bridge call is safe', (await js('window.susurro.record.pause()')).ok);

  const replacement = await js(`(async () => ({
    create: await window.susurro.session.create({name: 'Must not replace active'}),
    open: await window.susurro.session.open(${JSON.stringify(initial.folder)}),
    close: await window.susurro.session.close(),
    start: await window.susurro.record.start({sampleRate: 48000}),
  }))()`);
  check('active paused recording rejects session replacement and restart', Object.values(replacement).every((value) => value.ok === false));
  check('rejected replacement preserves session identity', (await current()).id === initial.id);

  for (let round = 0; round < 2; round++) {
    await click('btnRecord');
    await poll('resumed UI', `document.getElementById('btnRecord').classList.contains('recording') && document.getElementById('btnEndSession').classList.contains('hidden')`);
    check('duplicate Resume bridge call is safe', (await js('window.susurro.record.resume()')).ok);
    check('resume enables microphone tracks', await js('window.__testAudio.every(a => a.stream.getAudioTracks().every(t => t.enabled))'));
    await delay(1450);
    if (round === 0) await capture('03-resumed');
    await firstPause();
    const roundSession = await current();
    check(`resume cycle ${round + 1} retains session and appends audio/transcript`, roundSession.id === initial.id &&
      roundSession.chunks.length === round + 2 && roundSession.transcript.words.length === round + 2);
  }

  win.setSize(680, 880);
  await capture('04-paused-minimum-680');
  const layout = await js(`(() => {
    const ids = ['btnRecord','btnEndSession','btnExportFolder','timer','viz','sourceList','transcript'];
    return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
      boxes: ids.map(id => {const b = document.getElementById(id).getBoundingClientRect(); return {id,left:b.left,right:b.right,top:b.top,bottom:b.bottom};}) };
  })()`);
  check('minimum-width recording controls fit without horizontal overflow', !layout.overflow &&
    layout.boxes.every((b) => b.left >= 0 && b.right <= layout.width));
  const pauseEnd = await current();

  // v1.5.1: END SESSION confirm is the only stop path; Cancel/Escape keep it paused.
  const confirmOpen = `!document.getElementById('endConfirm').classList.contains('hidden')`;
  await click('btnEndSession');
  await poll('end confirm shown', confirmOpen);
  await capture('05-end-confirm');
  await click('btnCancelEnd');
  check('cancel keeps the session paused', (await ui()).paused && !(await current()).recording.stoppedAt);
  await click('btnEndSession');
  await poll('end confirm re-opened', confirmOpen);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  check('escape keeps the session paused', (await ui()).confirmHidden && (await ui()).paused);
  await click('btnEndSession');
  await poll('end confirm re-shown', confirmOpen);
  await click('btnConfirmEnd');
  await poll('stopped via confirm', `document.getElementById('btnRecord').classList.contains('recording') === false
    && document.getElementById('btnRecord').classList.contains('paused') === false
    && document.getElementById('btnEndSession').classList.contains('hidden')
    && !document.getElementById('btnRecord').disabled`);
  const stopped = await current();
  const full = path.join(stopped.folder, 'audio', 'full.wav');
  check('stop while paused finalizes same session', stopped.id === initial.id && !!stopped.recording.stoppedAt && !(await ui()).recording);
  check('stop while paused preserves chunk count', stopped.chunks.length === pauseEnd.chunks.length);
  const { readHeader, HEADER_BYTES } = require('../src/main/wav');
  const chunksPcm = Buffer.concat(stopped.chunks.map((chunk) => fs.readFileSync(path.join(stopped.folder, chunk.audioFile)).subarray(HEADER_BYTES)));
  assert.deepEqual(fs.readFileSync(full).subarray(HEADER_BYTES), chunksPcm);
  const duration = readHeader(full).dataBytes / (stopped.recording.sampleRate * 2);
  check('full WAV contains precisely captured audio, no paused silence', Math.abs(duration - pauseEnd.recording.durationSec) < 1 / stopped.recording.sampleRate);
  let offset = 0;
  for (const chunk of stopped.chunks) {
    assert.ok(Math.abs(chunk.offsetSec - offset) < 1 / stopped.recording.sampleRate);
    offset += chunk.durationSec;
  }
  check('resumed chunks have continuous sample-derived offsets', true);
  check('renderer transcribes every synthetic segment', stopped.transcript.words.length === 3 && asrCalls === 3);
  check('capture stream was opened only once for all resume cycles', await js('window.__testGetUserMediaCalls === 1'));
  check('export folder reveal resolves for the active session', (await js('window.susurro.exportReveal()')).ok === true);

  const fullHash = hash(full);
  check('stopped recording cannot restart over existing chunks', !(await js('window.susurro.record.start({sampleRate: 48000})')).ok);
  await click('btnRecord');
  await delay(150);
  check('UI blocks a new take from overwriting the session', (await current()).id === initial.id && hash(full) === fullHash && !(await ui()).recording);
  const afterStopControls = await js('(async () => [await window.susurro.record.pause(), await window.susurro.record.resume(), await window.susurro.record.stop()])()');
  check('pause/resume/stop after finishing cannot reopen recording', afterStopControls.every((value) => !value.ok));
  await js('window.susurro.session.close()');
  check('closed session cannot restart recording', !(await js('window.susurro.record.start({sampleRate: 48000})')).ok && hash(full) === fullHash);
  check('renderer has no page errors', !(await ui()).error && pageErrors.length === 0);
  await js('Promise.all(window.__testAudio.map(a => a.context.close()))');
  console.log(`RECORD-UI-RESULT: ${JSON.stringify({ ok: true, sessionId: initial.id, durationSec: duration, chunks: stopped.chunks.length, root, screenshots: shots })}`);
  clearTimeout(watchdog);
  app.exit(0);
}
