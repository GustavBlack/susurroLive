'use strict';
/**
 * susurroLive - Electron main process (composition root).
 *
 * Owns: window, settings, GPU probe, transcription engine, pipeline, recorder, sessions, exports.
 * The renderer is a pure projection that talks through the preload bridge.
 */
const { app, BrowserWindow, Menu, ipcMain, desktopCapturer, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const { detectGpu } = require('./gpu');
const { createSettings } = require('./settings');
const { Engine } = require('./whisper');
const { ParakeetEngine } = require('./engines/parakeet');
const { ParakeetProvisioner } = require('./engines/parakeet-provision');
const { EngineSelector } = require('./engines');
const { ModelManager } = require('./models');
const { Pipeline } = require('./pipeline');
const { Recorder } = require('./recorder');
const store = require('./session');
const { concatWavs } = require('./wav');
const { rebuildTranscript } = require('./assemble');
const exporters = require('./exporters');
const ffmpegBridge = require('./ffmpeg');
const { importMedia } = require('./importer');
const diarizer = require('./diarizer');   // called through the module so tests can stub runDiarize
const { buildBlock, wordSpeakersFor } = require('./diarize-join');
const { initUpdater } = require('./updater');

const SMOKE = process.argv.includes('--smoke');
const SMOKE_SESSION = (process.argv.find((a) => a.startsWith('--smoke-session=')) || '').split('=')[1] || null;
const SMOKE_IMPORT = process.argv.includes('--smoke-import');

// --------------------------------------------------------------------------- paths
const REPO_ROOT = path.join(__dirname, '..', '..');
const BIN_DIR = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(REPO_ROOT, 'native', 'bin');
const MODEL_DIR = app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(REPO_ROOT, 'native', 'models');
const RENDERER_HTML = path.join(__dirname, '..', 'renderer', 'index.html');

// --------------------------------------------------------------------------- app state
let win = null;
let settings = null;
let engine = null;
let engineSelector = null;
let parakeetProvision = null;
let models = null;
let gpu = null;
let pipeline = null;
let recorder = null;
let active = null;           // active session object
let recording = false;
let importing = false;
let diarizeRun = null;       // { folder, child } while a diarize run is in flight
let autoDiarizeFolder = null; // session to diarize once its transcription goes idle
let updaterState = null;

function send(evt, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(`evt:${evt}`, payload);
}

const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Push the merged transcript; wordSpeakers is derived from the SAME words array. */
function sendTranscript() {
  if (!active) return;
  send('transcript', {
    words: active.transcript.words,
    segments: active.transcript.segments,
    fullText: active.transcript.fullText,
    wordSpeakers: wordSpeakersFor(active),
    // identity of the block, so the renderer knows when to re-render with speakers
    diarization: active.diarization
      ? { speakers: active.diarization.speakers, createdAt: active.diarization.createdAt }
      : null,
  });
}

/** Pipeline event sink. Rebuilds the merged transcript whenever a chunk lands. */
function emit(evt, payload) {
  if (evt === 'chunkDone' && active) {
    rebuildTranscript(active);
    persist();
    sendTranscript();
  }
  send(evt, payload);
  if (evt === 'pipeline' && payload?.state === 'idle') maybeAutoDiarize();
}

/** Auto-diarize fires when transcription of a just-stopped/imported session goes idle. */
function maybeAutoDiarize() {
  if (!autoDiarizeFolder || !active || recording || !samePath(active.folder, autoDiarizeFolder)) return;
  autoDiarizeFolder = null;
  if (!settings.get('diarizeAutoOnStop')) return;
  // Defer: this runs inside the pipeline's pump.
  setImmediate(() => {
    diarizeActive().then((r) => { if (!r.ok) console.warn('[diarize] auto-run skipped:', r.error); });
  });
}

/** Store a finished block in its OWN session, even if the user switched sessions mid-run. */
function saveDiarization(folder, block) {
  if (active && samePath(active.folder, folder)) {
    active.diarization = block;
    persist();
    sendTranscript();
    return { ok: true };
  }
  try {
    return store.updateSessionFile(folder, (s) => { s.diarization = block; });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

/** Guarded diarize run over the active session. Resolves when the run is finished. */
async function diarizeActive() {
  if (!active) return { ok: false, error: 'no session' };
  if (recording) return { ok: false, error: 'stop recording before identifying speakers' };
  if (importing) return { ok: false, error: 'wait for the import to finish' };
  if (pipeline && pipeline.remaining > 0) return { ok: false, error: 'wait for transcription to finish' };
  if (!active.transcript?.words?.length) return { ok: false, error: 'nothing transcribed yet' };
  if (diarizeRun) return { ok: false, error: 'speaker diarization is already running' };

  const target = active;
  const folder = target.folder;
  const run = { folder, child: null, cancelled: false };
  diarizeRun = run;
  send('diarizeProgress', { folder, pct: null }); // the CLI reports no progress: indeterminate
  let res;
  try {
    res = await diarizer.runDiarize({
      session: target,
      repoRoot: REPO_ROOT,
      binDir: BIN_DIR,
      modelDir: MODEL_DIR,
      ffmpegPath: ffmpegBridge.findFfmpeg(REPO_ROOT, BIN_DIR),   // 16 kHz first: ~36% less RAM
      onSpawned: (child) => { run.child = child; },
    });
  } finally {
    diarizeRun = null;
  }
  if (run.cancelled) {
    send('diarizeError', { folder, error: 'cancelled', cancelled: true });
    return { ok: false, error: 'cancelled', cancelled: true, folder };
  }
  if (!res.ok) {
    send('diarizeError', { folder, error: res.error });
    return res;
  }
  const block = buildBlock(res);
  const saved = saveDiarization(folder, block);
  if (!saved.ok) {
    send('diarizeError', { folder, error: saved.error });
    return saved;
  }
  send('diarizeDone', { folder, speakers: block.speakers });
  return { ok: true, folder, speakers: block.speakers, turns: block.turns.length, ms: res.ms };
}

function persist() {
  if (!active) return;
  try { store.writeSession(active.folder, active); } catch (e) { console.error('persist failed', e); }
}

function publicSession() {
  if (!active) return null;
  const full = path.join(active.folder, 'audio', 'full.wav');
  return {
    ...active,
    audioUrl: fs.existsSync(full) ? pathToFileURL(full).href : null,
    wordSpeakers: wordSpeakersFor(active),
  };
}

function makePipeline() {
  return new Pipeline({
    engine: engineSelector,
    getSession: () => active,
    onPersist: persist,
    emit,
    gpu,
    device: active?.model?.device || 'auto',
  });
}

/** Open a session folder and make it active. */
function activateSession(folder) {
  if (recording) return { ok: false, error: 'stop recording before opening another session' };
  const r = store.openSession(folder);
  if (!r.ok) return r;
  active = r.session;
  store.ensureDirs(active.folder);
  store.ensureManifest(active.folder);   // older folders get the agent contract on first open
  pipeline = makePipeline();
  rebuildTranscript(active);
  return { ok: true, session: publicSession() };
}

// ---------------------------------------------------------------- window
/** Pre-paint flash color: the persisted theme's background (generated data mirror). */
function themeBackgroundColor() {
  try {
    const themes = require('./renderer/theme/themes.json');
    const t = themes.find((x) => x.id === settings?.get('theme')) || themes[0];
    return (settings?.get('themeMode') === 'light' ? t.light : t.dark).bg;
  } catch { return '#18181b'; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 820,
    height: 1040,
    minWidth: 680,
    minHeight: 880,
    backgroundColor: themeBackgroundColor(),
    title: 'susurroLive',
    show: !SMOKE,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(RENDERER_HTML);
  // Right-click anywhere: the one folder the user owns is the sessions root (v1.5.1).
  win.webContents.on('context-menu', () => {
    const dir = settings.get('lastSessionParent');
    Menu.buildFromTemplate([{
      label: 'Open Sessions Folder',
      enabled: !!dir,
      click: () => { if (dir) void shell.openPath(dir); },
    }]).popup({ window: win });
  });
  win.on('closed', () => { win = null; });
  return win;
}

// --------------------------------------------------------------------------- ipc
function registerIpc() {
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:paths', () => ({
    repo: REPO_ROOT, bin: BIN_DIR, models: MODEL_DIR, userData: app.getPath('userData'),
  }));

  ipcMain.handle('gpu:probe', () => gpu);
  ipcMain.handle('engine:status', () => ({ ...engine.status(), gpu, engines: engineSelector.status() }));

  // -------- parakeet in-app provisioning --------
  ipcMain.handle('parakeet:provisioned', () => parakeetProvision.provisioned());
  ipcMain.handle('parakeet:download', () => parakeetProvision.download());
  ipcMain.handle('parakeet:cancel', () => parakeetProvision.cancel());

  // -------- in-app updates (NSIS-installed builds only; inert in dev/portable) --------
  ipcMain.handle('update:check', () => (updaterState?.check ? updaterState.check() : { ok: false, error: 'updates unavailable in this build' }));
  ipcMain.handle('update:download', () => (updaterState?.download ? updaterState.download() : { ok: false, error: 'updates unavailable in this build' }));
  ipcMain.handle('update:install', () => (updaterState?.install ? updaterState.install() : { ok: false, error: 'updates unavailable in this build' }));
  ipcMain.handle('update:status', () => (updaterState ? { ...updaterState, check: undefined, download: undefined, install: undefined } : { feedConfigured: false }));

  ipcMain.handle('settings:get', () => settings.all());
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = settings.set(patch || {});
    // Model / language / device / VAD changes apply to the session in flight, so the next
    // chunk picks them up without having to start a new session.
    if (active && active.model) {
      if (patch?.model) active.model.name = patch.model;
      if (patch?.language) active.model.language = patch.language;
      if (patch?.device) active.model.device = patch.device;
      if (typeof patch?.vad === 'boolean') active.model.vad = patch.vad;
      if (patch?.engine === 'whisper' || patch?.engine === 'parakeet') active.model.engine = patch.engine;
      persist();
    }
    return next;
  });

  // -------- models (download / cancel / remove) --------
  ipcMain.handle('models:catalog', () => models.list());
  ipcMain.handle('models:download', (_e, id) => models.download(id));
  ipcMain.handle('models:cancel', (_e, id) => models.cancel(id));
  ipcMain.handle('models:remove', (_e, id) => models.remove(id));

  ipcMain.handle('capture:desktopSources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    return sources.map((s) => ({ id: s.id, name: s.name || 'Entire Screen' }));
  });

  // -------- session folder --------
  ipcMain.handle('session:pickFolder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose where sessions are saved',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    settings.set({ lastSessionParent: res.filePaths[0] });
    return res.filePaths[0];
  });

  ipcMain.handle('session:create', (_e, opts = {}) => {
    if (recording) return { ok: false, error: 'stop recording before creating another session' };
    try {
      const parentDir = opts.parentDir || settings.get('lastSessionParent');
      if (!parentDir) return { ok: false, error: 'no session folder chosen yet' };
      fs.mkdirSync(parentDir, { recursive: true });
      settings.set({ lastSessionParent: parentDir });

      active = store.createSession({
        parentDir,
        name: opts.name || 'Session',
        settings: settings.all(),
        gpu,
        model: { name: opts.model || settings.get('model'), device: opts.device || settings.get('device') },
        chunkSec: opts.chunkSec || settings.get('chunkSec'),
        sources: opts.sources || [],
      });
      pipeline = makePipeline();
      return { ok: true, session: publicSession() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('session:open', (_e, folder) => activateSession(folder));

  ipcMain.handle('session:openDialog', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Open a session folder (must contain session.json)',
      properties: ['openDirectory'],
      defaultPath: settings.get('lastSessionParent') || undefined,
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, error: 'cancelled' };
    return activateSession(res.filePaths[0]);
  });

  ipcMain.handle('session:list', (_e, parent) => {
    const dir = parent || settings.get('lastSessionParent');
    if (!dir) return [];
    return store.listSessions(dir);
  });

  ipcMain.handle('session:current', () => publicSession());
  ipcMain.handle('session:close', () => {
    if (recording) return { ok: false, error: 'stop recording before closing the session' };
    active = null; pipeline = null; return { ok: true };
  });

  // -------- import prerecorded media (audio or video) --------
  ipcMain.handle('import:pickMedia', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Import audio or video (the audio track becomes a session)',
      properties: ['openFile'],
      filters: [ffmpegBridge.mediaFilterName(), { name: 'All files', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('import:run', async (_e, { mediaPath, name } = {}) => {
    try {
      if (!mediaPath || !fs.existsSync(mediaPath)) return { ok: false, error: 'media file not found' };
      const ext = path.extname(mediaPath).slice(1).toLowerCase();
      if (!ffmpegBridge.MEDIA_EXTS.has(ext)) {
        return { ok: false, error: `unsupported file type .${ext}` };
      }
      const ffmpegPath = ffmpegBridge.findFfmpeg(REPO_ROOT, BIN_DIR);
      if (!ffmpegPath) {
        return { ok: false, error: 'ffmpeg not found - put ffmpeg.exe in native/bin or on PATH' };
      }
      const parentDir = settings.get('lastSessionParent');
      if (!parentDir) return { ok: false, error: 'no session folder chosen yet' };

      if (recording) return { ok: false, error: 'stop recording before importing' };

      // Import replaces the active session (same as creating a new one).
      importing = true;
      active = store.createSession({
        parentDir,
        name: name || path.basename(mediaPath, path.extname(mediaPath)) || 'Import',
        settings: settings.all(),
        gpu,
        model: { name: settings.get('model'), device: settings.get('device') },
        chunkSec: settings.get('chunkSec'),
        sources: [],
      });
      pipeline = makePipeline();

      const r = await importMedia({
        ffmpegPath,
        session: active,
        mediaPath,
        chunkSec: active.recording.chunkSec,
        onPersist: persist,
        onProgress: (evt, payload) => { send(evt, payload); send('status', { importing: evt === 'import' && payload?.phase !== 'done' }); },
      });
      importing = false;
      if (!r.ok) { persist(); return r; }

      rebuildTranscript(active);
      persist();
      send('recordState', { recording: false });
      autoDiarizeFolder = active.folder;   // honoured once transcription goes idle
      // Kick off transcription of the whole imported file, live (same as Stop does).
      if (pipeline) pipeline.enqueueAllOutstanding();
      send('status', { importing: false });
      return { ok: true, session: publicSession(), seconds: r.seconds, chunks: r.chunks };
    } catch (err) {
      importing = false;
      return { ok: false, error: String(err.message || err) };
    }
  });


  ipcMain.handle('session:rename', (_e, name) => {
    if (!active) return { ok: false, error: 'no session' };
    active.name = String(name || 'Session').trim() || 'Session';
    persist();
    return { ok: true, name: active.name };
  });

  ipcMain.handle('session:buildFull', () => {
    if (!active) return { ok: false, error: 'no session' };
    if (recording) return { ok: false, error: 'stop recording before building playback audio' };
    try {
      const chunks = active.chunks.slice().sort((a, b) => a.index - b.index)
        .map((c) => path.join(active.folder, c.audioFile))
        .filter((p) => fs.existsSync(p));
      if (!chunks.length) return { ok: false, error: 'no audio chunks yet' };
      const out = path.join(active.folder, 'audio', 'full.wav');
      const r = concatWavs(chunks, out);
      if (r) active.recording.durationSec = Number(r.seconds.toFixed(2));
      persist();
      return { ok: true, audioUrl: pathToFileURL(out).href, seconds: active.recording.durationSec };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // -------- recording --------
  ipcMain.handle('record:start', (_e, opts = {}) => {
    if (!active) return { ok: false, error: 'create or open a session first' };
    if (recording) return { ok: false, error: 'recording is already active; use Resume if paused' };
    if (active.chunks.length) return { ok: false, error: 'create a new session to record another take' };
    try {
      active.recording.startedAt = new Date().toISOString();
      active.recording.stoppedAt = null;
      active.recording.durationSec = 0;
      active.recording.sources = opts.sources || [];
      active.chunks = [];
      active.transcript = { language: null, fullText: '', words: [], segments: [] };
      persist();

      active.recording.sampleRate = opts.sampleRate || 48000;
      recorder = new Recorder({
        session: active,
        chunkSec: active.recording.chunkSec || 60,
        sampleRate: active.recording.sampleRate,
        onChunkClosed: (idx) => {
          persist();
          send('chunks', active.chunks.map((c) => ({
            index: c.index, status: c.status, durationSec: c.durationSec,
          })));
          if (pipeline) pipeline.enqueue(idx);
        },
      });
      recorder.start();
      recording = true;
      persist();
      send('recordState', { recording: true, paused: false, durationSec: 0 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('record:pause', () => {
    if (!recording || !recorder) return { ok: false, error: 'no active recording' };
    try {
      recorder.pause();
      active.recording.durationSec = recorder.recordedSeconds;
      persist();
      const state = { recording: true, paused: true, durationSec: recorder.recordedSeconds };
      send('recordState', state);
      return { ok: true, ...state };
    } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  ipcMain.handle('record:resume', () => {
    if (!recording || !recorder) return { ok: false, error: 'no active recording' };
    try {
      recorder.resume();
      persist();
      const state = { recording: true, paused: false, durationSec: recorder.recordedSeconds };
      send('recordState', state);
      return { ok: true, ...state };
    } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  ipcMain.handle('record:stop', () => {
    if (!recording || !active || !recorder) return { ok: false, error: 'no active recording' };
    try {
      recording = false;
      if (recorder) { recorder.stop(); recorder = null; }
      active.recording.stoppedAt = new Date().toISOString();
      active.recording.durationSec = Number(
        active.chunks.reduce((n, c) => n + (c.durationSec || 0), 0).toFixed(2),
      );
      persist();

      const chunks = active.chunks.slice().sort((a, b) => a.index - b.index)
        .map((c) => path.join(active.folder, c.audioFile))
        .filter((p) => fs.existsSync(p));
      let audioUrl = null;
      if (chunks.length) {
        const out = path.join(active.folder, 'audio', 'full.wav');
        concatWavs(chunks, out);
        audioUrl = pathToFileURL(out).href;
      }

      send('recordState', { recording: false, paused: false, durationSec: active.recording.durationSec });
      // Transcription is still running here; auto-diarize waits for the pipeline to go idle.
      autoDiarizeFolder = active.folder;
      if (pipeline) pipeline.enqueueAllOutstanding();
      return {
        ok: true, audioUrl,
        durationSec: active.recording.durationSec,
        chunks: active.chunks.length,
      };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // -------- pcm firehose (renderer -> main) --------
  ipcMain.on('audio:pcm', (_e, raw) => {
    if (!recording || !recorder || recorder.paused) return;
    let buf;
    if (Buffer.isBuffer(raw)) buf = raw;
    else if (raw instanceof ArrayBuffer) buf = Buffer.from(raw);
    else if (raw && raw.buffer) buf = Buffer.from(raw.buffer, raw.byteOffset || 0, raw.byteLength);
    else return;
    try { recorder.push(buf); } catch (err) { console.error('pcm write failed', err); }
  });

  // -------- pipeline --------
  ipcMain.handle('pipeline:retry', (_e, index) => {
    if (!pipeline || !active) return { ok: false, error: 'no session' };
    const c = active.chunks.find((x) => x.index === index);
    if (c) { c.status = 'queued'; c.error = null; pipeline.enqueue(index); }
    return { ok: true };
  });

  ipcMain.handle('pipeline:retryAll', () => {
    if (!pipeline) return { ok: false, error: 'no session' };
    pipeline.enqueueAllOutstanding();
    return { ok: true };
  });

  ipcMain.handle('pipeline:status', () => ({
    remaining: pipeline ? pipeline.remaining : 0,
    running: pipeline ? pipeline.running : 0,
    concurrency: pipeline ? pipeline.concurrency : 0,
  }));

  // -------- export --------
  ipcMain.handle('export:run', (_e, kind) => {
    if (!active) return { ok: false, error: 'no session' };
    try {
      const dir = path.join(active.folder, 'exports');
      fs.mkdirSync(dir, { recursive: true });
      let res;
      if (kind === 'txt') res = exporters.exportTxt(active, path.join(dir, 'full.txt'));
      else if (kind === 'json') res = exporters.exportJson(active, path.join(dir, 'full.json'));
      else if (kind === 'audio') res = exporters.exportAudio(active, path.join(dir, 'full.wav'), { concatWavs });
      else return { ok: false, error: `unknown export kind: ${kind}` };

      active.exports.push({
        kind,
        path: path.relative(active.folder, res.path).replace(/\\/g, '/'),
        at: new Date().toISOString(),
      });
      persist();
      return { ok: true, path: res.path, bytes: res.bytes };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('export:reveal', () => {
    if (!active) return { ok: false, error: 'no session' };
    try {
      const dir = path.join(active.folder, 'exports');
      fs.mkdirSync(dir, { recursive: true }); // reveal works before the first export
      void shell.openPath(dir);
      return { ok: true, path: dir };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // -------- speaker diarization (post-hoc, turns only) --------
  ipcMain.handle('diarize:status', () => ({
    ...diarizer.status({ repoRoot: REPO_ROOT, binDir: BIN_DIR, modelDir: MODEL_DIR }),
    running: diarizeRun ? diarizeRun.folder : null,
  }));
  ipcMain.handle('diarize:run', () => diarizeActive());
  // An hour of audio takes minutes on CPU; the user can stop it. Nothing is saved.
  ipcMain.handle('diarize:cancel', () => {
    if (!diarizeRun) return { ok: false, error: 'speaker diarization is not running' };
    diarizeRun.cancelled = true;
    try { diarizeRun.child?.kill(); } catch { /* already gone */ }
    return { ok: true };
  });

  ipcMain.handle('shell:reveal', (_e, p) => { if (p) shell.showItemInFolder(p); return { ok: true }; });
  ipcMain.handle('shell:copy', (_e, t) => { clipboard.writeText(String(t ?? '')); return { ok: true }; });
}

// --------------------------------------------------------------------------- bootstrap
app.whenReady().then(() => {
  settings = createSettings(app.getPath('userData'));
  engine = new Engine({ binDir: BIN_DIR, modelDir: MODEL_DIR });
  const parakeet = new ParakeetEngine({
    repoRoot: REPO_ROOT,
    binDir: BIN_DIR,
    modelDir: MODEL_DIR,
    // the in-app provisioner installs into userData (packaged) / repo root (dev) — the engine
    // must look THERE for the downloaded exe+model, not only in the read-only resources dir.
    provisionDir: app.isPackaged ? app.getPath('userData') : REPO_ROOT,
    ffmpegPath: ffmpegBridge.findFfmpeg(REPO_ROOT, BIN_DIR),
  });
  engineSelector = new EngineSelector({ whisper: engine, parakeet, getSettings: () => settings });
  parakeetProvision = new ParakeetProvisioner({
    dir: app.isPackaged ? app.getPath('userData') : REPO_ROOT,
    emit: send,
  });
  models = new ModelManager({ modelDir: MODEL_DIR, emit: send });
  gpu = detectGpu({ binaryCuda: engine.binaryCuda });

  registerIpc();

  // Optional: preload a session so the renderer boots straight into real content (smoke/dev).
  if (SMOKE_SESSION) {
    const r = activateSession(SMOKE_SESSION);
    console.log('[susurroLive] preloaded session:', r.ok ? r.session.name : r.error);
  }

  createWindow();

  // In-app updates: only active for NSIS-installed, packaged builds (see src/main/updater.js).
  updaterState = initUpdater({ send, userDataDir: app.getPath('userData') });

  win.webContents.once('did-finish-load', () => {
    console.log('[susurroLive] window loaded');
    console.log('[susurroLive] gpu   :', JSON.stringify(gpu));
    console.log('[susurroLive] engine:', JSON.stringify(engine.status()));
    if (SMOKE) runSmoke();
    if (SMOKE_IMPORT) runSmokeImport();
  });

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

async function runSmoke() {
  try {
    await new Promise((r) => setTimeout(r, 2200));

    // Smoke artifacts live in the repo during dev; a packaged build has no repo,
    // so land them in temp instead (the asar is not a writable directory).
    const smokeDir = app.isPackaged ? app.getPath('temp') : path.join(REPO_ROOT, 'native');
    const smokePath = (name) => path.join(smokeDir, name);

    // 1) main view
    let img = await win.webContents.capturePage();
    const out = smokePath('_smoke.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, img.toPNG());

    // 2) settings drawer, to exercise the model manager
    await win.webContents.executeJavaScript("document.getElementById('btnSettings').click()");
    await new Promise((r) => setTimeout(r, 1200));
    img = await win.webContents.capturePage();
    const out2 = smokePath('_smoke_settings.png');
    fs.writeFileSync(out2, img.toPNG());

    // 2.5) v1.5 theme swap: pick Tokyo Night, verify staged animation + persistence.
    const themeCheck = await win.webContents.executeJavaScript(`(async () => {
      let opt = null;
      for (let i = 0; i < 50 && !opt; i++) {   // wire() may still be awaiting boot
        opt = document.querySelector('.theme-opt[data-id="tokyo"]');
        if (!opt) await new Promise((r) => setTimeout(r, 100));
      }
      if (!opt) return JSON.stringify({ fail: 'no tokyo option rendered' });
      opt.click();
      await new Promise((r) => setTimeout(r, 120));   // inside the 780 ms anim window
      const html = document.documentElement;
      const midAnim = html.classList.contains('theme-anim');
      const accent = getComputedStyle(html).getPropertyValue('--accent').trim();
      await new Promise((r) => setTimeout(r, 900));   // past the 780 ms cleanup
      return JSON.stringify({
        theme: html.dataset.theme,
        mode: html.dataset.themeMode,
        midAnim,
        animCleared: !html.classList.contains('theme-anim'),
        accent,
      });
    })()`);
    console.log('[smoke] theme swap   :', themeCheck);
    try {
      const tc = JSON.parse(themeCheck);
      if (tc.fail || tc.theme !== 'tokyo' || tc.mode !== 'dark' || !tc.midAnim || !tc.animCleared || !/^#7aa2f7$/i.test(tc.accent)) {
        console.error(`[smoke] FAILED: theme swap state wrong: ${themeCheck}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }
    const themePersisted = (() => { try { return JSON.parse(fs.readFileSync(settings.file, 'utf8')).theme; } catch { return null; } })();
    console.log('[smoke] theme persisted:', themePersisted);
    if (themePersisted !== 'tokyo') {
      console.error('[smoke] FAILED: theme choice not persisted to settings.json');
      process.exitCode = 1;
    }
    img = await win.webContents.capturePage();
    fs.writeFileSync(smokePath('_smoke_theme.png'), img.toPNG());
    // restore the default theme so the remaining artifact shots stay canonical
    await win.webContents.executeJavaScript(`(async () => {
      const opt = document.querySelector('.theme-opt[data-id="default"]');
      if (opt) { opt.click(); await new Promise((r) => setTimeout(r, 900)); }
    })()`);

    // 3) back to the main view, then shrink the window so the transcript definitely
    //    overflows - otherwise there is no scrollbar on screen to inspect.
    await win.webContents.executeJavaScript("document.getElementById('btnCloseSettings').click()");
    await new Promise((r) => setTimeout(r, 400));
    const overflow = await win.webContents.executeJavaScript(
      '(() => { const b = document.getElementById("transcript"); return b ? b.scrollHeight - b.clientHeight : -1; })()',
    );
    console.log('[smoke] transcript overflow px:', overflow);
    // Frame check: the transcript must never extend past its panel, or its scrollbar paints
    // outside the rounded border. Regression guard for the border-box padding-floor bug.
    const frame = await win.webContents.executeJavaScript(`(() => {
      const t = document.getElementById('transcript');
      const panel = t && t.closest('.panel');
      if (!t || !panel) return 'no transcript panel';
      const tb = t.getBoundingClientRect(), pb = panel.getBoundingClientRect();
      return JSON.stringify({
        transcriptH: Math.round(tb.height),
        panelH: Math.round(pb.height),
        overhangPx: Math.round(tb.bottom - pb.bottom),
      });
    })()`);
    console.log('[smoke] frame check :', frame);
    try {
      const o = JSON.parse(frame);
      if (o.overhangPx > 0) {
        console.error(`[smoke] FAILED: transcript overhangs its panel by ${o.overhangPx}px`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }
    win.setSize(820, 700);
    await new Promise((r) => setTimeout(r, 1100));
    img = await win.webContents.capturePage();
    const out3 = smokePath('_smoke_scroll.png');
    fs.writeFileSync(out3, img.toPNG());
    console.log('[smoke] scroll png        :', out3);

    const title = await win.webContents.executeJavaScript('document.title');
    const bridge = await win.webContents.executeJavaScript('!!window.susurro');
    const rows = await win.webContents.executeJavaScript('document.querySelectorAll(".src-row").length');
    const modelRows = await win.webContents.executeJavaScript('document.querySelectorAll(".model-row").length');
    const modelNames = await win.webContents.executeJavaScript(
      '[...document.querySelectorAll(".model-row")].map(r => r.dataset.id + ":" + r.className.replace("model-row","").trim()).join(" | ")',
    );
    const errs = await win.webContents.executeJavaScript('window.__err || null');

    console.log('[smoke] screenshot  :', out);
    console.log('[smoke] settings png:', out2);
    console.log('[smoke] title       :', title);
    console.log('[smoke] bridge      :', bridge);
    console.log('[smoke] source rows :', rows);
    console.log('[smoke] model rows  :', modelRows);
    console.log('[smoke] models      :', modelNames);
    console.log('[smoke] page errors :', errs);
    console.log('[smoke] OK');
  } catch (err) {
    console.error('[smoke] FAILED:', err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// A diarize run can take minutes; never leave the sidecar running after the app is gone.
app.on('will-quit', () => { try { diarizeRun?.child?.kill(); } catch { /* already gone */ } });

/**
 * Headless import E2E: drive the renderer's real bridge through api.import.run, wait for
 * the pipeline to settle, then read the ACTUAL UI state (chunk strip, pipeStatus text,
 * retry visibility). This is the regression test for "strip stays 0/N after import".
 */
async function runSmokeImport() {
  try {
    await new Promise((r) => setTimeout(r, 2000));
    const mediaPath = process.env.SUSURRO_IMPORT_FILE;
    const parent = process.env.SUSURRO_IMPORT_PARENT;
    if (!mediaPath || !parent) throw new Error('SUSURRO_IMPORT_FILE / SUSURRO_IMPORT_PARENT not set');

    const r = await win.webContents.executeJavaScript(`(async () => {
      const api = window.susurro;
      // Fresh-boot state FIRST: no session, no chunks rendered — the original bug
      // was the retry button being visible here because its toggle only ever ran
      // inside renderChunks(), which requires a session with chunks.
      const bootRetryHidden = document.getElementById('btnRetryAll')?.classList.contains('hidden');
      await api.settings.set({ lastSessionParent: ${JSON.stringify(parent)}, chunkSec: 30 });
      const res = await api.import.run({ mediaPath: ${JSON.stringify(mediaPath)} });
      // wait for the pipeline to fully drain (transcription is real here)
      for (let i = 0; i < 240; i++) {
        const st = await api.pipeline.status();
        if (st.remaining === 0 && st.running === 0) break;
        await new Promise((ok) => setTimeout(ok, 500));
      }
      await new Promise((ok) => setTimeout(ok, 600)); // let the last renders land
      const live = await api.session.current();
      const chips = [...document.querySelectorAll('#chunkStrip .chip')];
      const done = chips.filter((c) => c.classList.contains('done')).length;
      const out = {
        importOk: !!res.ok,
        error: res.error || null,
        chunks: (live?.chunks || []).length,
        uiDone: done,
        pipeText: document.getElementById('pipeStatus')?.textContent || '',
        retryHidden: document.getElementById('btnRetryAll')?.classList.contains('hidden'),
        words: (live?.transcript?.words || []).length,
      };
      out.bootRetryHidden = bootRetryHidden;
      // Clean-state variant: close the session (no chunks rendered at all) and check
      // that the retry button hides — the original bug: toggle only ran when a
      // session with chunks was rendered, so a clean boot kept the button visible.
      await api.session.close();
      document.getElementById('chunkStrip').innerHTML = '';
      document.getElementById('pipeStatus').textContent = '0 queued';
      out.cleanRetryHidden = document.getElementById('btnRetryAll').classList.contains('hidden');
      return out;
    })()`);
    console.log('IMPORT-UI-RESULT:', JSON.stringify(r));
  } catch (err) {
    console.error('[smoke-import] FAILED:', err);
  } finally {
    app.quit();
  }
}
