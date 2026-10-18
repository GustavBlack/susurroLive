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
const { probeModels } = require('./llm/client');
const { runCheckup, applyCheckup } = require('./llm/checkup');
const { createVocabulary } = require('./llm/vocabulary');
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
let checkupRun = null;       // { folder, ctrl } while an LLM checkup run is in flight
let vocabulary = null;       // createVocabulary(userData) — built once after app ready
let autoDiarizeFolder = null; // session to diarize once its transcription goes idle
let updaterState = null;

function send(evt, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(`evt:${evt}`, payload);
}

const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Read-time projection for the AI checkup: corrected words + drifted chunk ids when a
 * checkup block exists, null otherwise (plain words array — the renderer handles both).
 * NEVER mutates the stored transcript.
 */
function projectedCheckup(session) {
  if (!session || !session.checkup) return null;
  const { words, driftedChunkIds } = applyCheckup(session.transcript.words || [], session.checkup);
  return { words, driftedChunkIds };
}

/** Push the merged transcript; wordSpeakers is derived from the SAME words array. */
function sendTranscript() {
  if (!active) return;
  const proj = projectedCheckup(active);
  send('transcript', {
    words: proj ? proj.words : active.transcript.words,
    ...(proj ? { driftedChunkIds: proj.driftedChunkIds } : {}),
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

/** Store a finished checkup block in its OWN session, even if the user switched mid-run. */
function saveCheckupBlock(folder, block) {
  if (active && samePath(active.folder, folder)) {
    active.checkup = block;
    persist();
    sendTranscript();
    return { ok: true };
  }
  try {
    return store.updateSessionFile(folder, (s) => { s.checkup = block; });
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
  const proj = projectedCheckup(active);
  return {
    ...active,
    audioUrl: fs.existsSync(full) ? pathToFileURL(full).href : null,
    wordSpeakers: wordSpeakersFor(active),
    // the projected view (corrected words + drift) when a checkup block exists
    ...(proj ? { transcript: { ...active.transcript, words: proj.words, driftedChunkIds: proj.driftedChunkIds } } : {}),
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

  // -------- AI transcript checkup (opt-in, non-destructive LLM corrections) --------
  ipcMain.handle('llm:probe', async () => {
    try {
      const r = await probeModels(settings.get('llmEndpoint'), settings.get('llmApiKey'));
      return { ok: true, models: r.models, contextTokens: r.contextTokens };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('llm:checkup:run', async () => {
    if (!active) return { ok: false, error: 'no session' };
    if (recording) return { ok: false, error: 'stop recording before running the AI checkup' };
    if (importing) return { ok: false, error: 'wait for the import to finish' };
    if (pipeline && pipeline.remaining > 0) return { ok: false, error: 'wait for transcription to finish' };
    if (diarizeRun) return { ok: false, error: 'wait for speaker diarization to finish' };
    if (!active.transcript?.words?.length) return { ok: false, error: 'nothing transcribed yet' };
    if (checkupRun) return { ok: false, error: 'an AI checkup run is already active' };
    if (!settings.get('llmCheckup')) return { ok: false, error: 'the AI checkup feature is disabled — enable it in Settings' };
    if (!settings.get('llmEndpoint')) return { ok: false, error: 'no endpoint configured — see Settings → AI transcript checkup' };
    if (!settings.get('llmModel')) return { ok: false, error: 'no model configured — see Settings → AI transcript checkup' };

    const folder = active.folder;
    const ctrl = new AbortController();
    checkupRun = { folder, ctrl };
    try {
      const block = await runCheckup({
        session: active,
        settings: settings.all(),
        signal: ctrl.signal,
        onProgress: (p) => send('llmCheckupProgress', p),
        vocabulary: vocabulary ? vocabulary.activeTerms() : [],
      });
      const saved = saveCheckupBlock(folder, block);   // words on disk are NEVER mutated
      if (!saved.ok) {
        send('llmCheckupError', { message: saved.error });
        return saved;
      }
      send('llmCheckupDone', { applied: block.applied });
      return { ok: true, applied: block.applied, batches: block.batches };
    } catch (err) {
      const cancelled = ctrl.signal.aborted || /cancelled/i.test(String(err.message || err));
      send('llmCheckupError', { message: String(err.message || err), cancelled });
      return { ok: false, error: String(err.message || err), cancelled };
    } finally {
      checkupRun = null;
    }
  });

  ipcMain.handle('llm:checkup:cancel', () => {
    if (!checkupRun) return { ok: false, error: 'no AI checkup run is active' };
    checkupRun.ctrl.abort();
    return { ok: true };
  });

  ipcMain.handle('llm:checkup:toggle', (_e, flag) => {
    if (!active) return { ok: false, error: 'no session' };
    if (!active.checkup) return { ok: false, error: 'no checkup block on this session' };
    active.checkup.active = flag === true;
    persist();
    sendTranscript();
    return { ok: true, active: active.checkup.active, session: publicSession() };
  });

  ipcMain.handle('llm:checkup:discard', () => {
    if (!active) return { ok: false, error: 'no session' };
    if (!active.checkup) return { ok: false, error: 'no checkup block on this session' };
    delete active.checkup;
    persist();
    sendTranscript();
    return { ok: true, session: publicSession() };
  });

  // -------- vocabulary profiles (userData/vocabulary.json) --------
  ipcMain.handle('llm:vocab:list', () => vocabulary.load());
  ipcMain.handle('llm:vocab:save', (_e, data) => {
    try { return vocabulary.save(data); }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
  ipcMain.handle('llm:vocab:reveal', () => {
    try { vocabulary.revealFile(); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  ipcMain.handle('shell:reveal', (_e, p) => { if (p) shell.showItemInFolder(p); return { ok: true }; });
  ipcMain.handle('shell:copy', (_e, t) => { clipboard.writeText(String(t ?? '')); return { ok: true }; });
}

// --------------------------------------------------------------------------- bootstrap
app.whenReady().then(() => {
  settings = createSettings(app.getPath('userData'));
  vocabulary = createVocabulary(app.getPath('userData'));
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

    // 2) settings drawer, to exercise the model manager. boot/wire is async, so
    //    poll until the drawer is actually visible before capturing.
    let drawerGeom = '';
    for (let i = 0; i < 50 && !/true/.test(drawerGeom); i++) {
      await win.webContents.executeJavaScript("document.getElementById('btnSettings')?.click()");
      await new Promise((r) => setTimeout(r, 200));
      drawerGeom = await win.webContents.executeJavaScript(
        '(() => { const d = document.getElementById("settingsDrawer");' +
        ' const r = d.getBoundingClientRect();' +
        ' return JSON.stringify({ open: !d.classList.contains("hidden"), x: r.x, w: r.width, vw: innerWidth, dpr: devicePixelRatio, disp: getComputedStyle(d).display }); })()');
    }
    console.log('[smoke] drawer geom  :', drawerGeom);
    const hitTest = await win.webContents.executeJavaScript(
      '(() => { const el = document.elementFromPoint(640, 500);' +
      ' return el ? (el.id || el.className || el.tagName) : "none"; })()');
    console.log('[smoke] hit @640,500:', hitTest);
    img = await win.webContents.capturePage();
    const out2 = smokePath('_smoke_settings.png');
    fs.writeFileSync(out2, img.toPNG());

    // 2.5) v1.5 theme swap: pick Tokyo Night, verify staged animation + persistence.
    const themeCheck = await win.webContents.executeJavaScript(`(async () => {
      let head = null;
      for (let i = 0; i < 50 && !head; i++) {   // wire() may still be awaiting boot
        head = document.querySelector('.theme-dd-head');
        if (!head) await new Promise((r) => setTimeout(r, 100));
      }
      if (!head) return JSON.stringify({ fail: 'no theme dropdown head rendered' });
      head.click();                             // expand the dropdown list
      await new Promise((r) => setTimeout(r, 120));
      let opt = null;
      for (let i = 0; i < 50 && !opt; i++) {
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

    // 2.6) About block: manual update check must give inline feedback (in dev the
    // feed is unconfigured, so the expected result is the portable/dev notice).
    const aboutCheck = await win.webContents.executeJavaScript(`(async () => {
      const btn = document.getElementById('btnCheckUpdate');
      const res = document.getElementById('updateResult');
      if (!btn || !res) return JSON.stringify({ fail: 'about block missing' });
      const ver = document.getElementById('aboutVersion')?.textContent || '';
      btn.click();
      for (let i = 0; i < 40 && !res.textContent; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 300));
      return JSON.stringify({ ver, feedback: res.textContent, shown: !res.classList.contains('hidden') });
    })()`);
    console.log('[smoke] about check  :', aboutCheck);
    try {
      const ac = JSON.parse(aboutCheck);
      if (ac.fail || !ac.ver.includes('susurroLive') || !ac.feedback) {
        console.error(`[smoke] FAILED: about block wrong: ${aboutCheck}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }

    // 2.7) v1.6.0 engine-first settings: #setEngine renders above #modelList, and the
    // model list is scoped to the engine (parakeet = exactly one row, nothing ggml).
    const engineCheck = await win.webContents.executeJavaScript(`(async () => {
      const eng = document.getElementById('setEngine');
      const ml = document.getElementById('modelList');
      if (!eng || !ml) return JSON.stringify({ fail: 'engine/model controls missing' });
      // boot wiring is async: poll until the model list has rendered at least once
      for (let i = 0; i < 50 && !ml.children.length; i++) await new Promise((r) => setTimeout(r, 100));
      const out = { startEngine: eng.value || 'whisper' };
      out.engineAboveModels = !!(eng.compareDocumentPosition(ml) & Node.DOCUMENT_POSITION_FOLLOWING);
      const pk = window.susurro ? (await window.susurro.engine.status())?.engines?.parakeet : null;
      // whisper first: the full catalog renders
      eng.value = 'whisper'; eng.dispatchEvent(new Event('change'));
      for (let i = 0; i < 50 && document.querySelectorAll('#modelList .model-row').length < 2; i++) await new Promise((r) => setTimeout(r, 100));
      out.whisperRows = document.querySelectorAll('#modelList .model-row').length;
      // parakeet scoping only when the engine is actually provisioned in THIS mode
      // (dev smoke looks in repo native/, packaged in userData — SKIP otherwise,
      // mirroring tools/test-parakeet-engine.js SKIP semantics)
      if (!pk || !pk.available) {
        out.parakeetSkipped = pk?.reason || 'parakeet not provisioned';
      } else {
        eng.value = 'parakeet'; eng.dispatchEvent(new Event('change'));
        for (let i = 0; i < 50 && document.querySelectorAll('#modelList .model-row').length !== 1; i++) await new Promise((r) => setTimeout(r, 100));
        const rows = [...document.querySelectorAll('#modelList .model-row')];
        out.parakeetRows = rows.length;
        out.parakeetIds = rows.map((r) => r.dataset.id || '').join(',');
        out.noGgml = rows.every((r) => !/ggml/i.test(r.dataset.id || ''));
        // restore the engine the user had before this stage
        eng.value = out.startEngine; eng.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 400));
      }
      return JSON.stringify(out);
    })()`);
    console.log('[smoke] engine order :', engineCheck);
    try {
      const ec = JSON.parse(engineCheck);
      const scopedOk = ec.parakeetSkipped != null || (ec.parakeetRows === 1 && ec.noGgml);
      if (ec.fail || !ec.engineAboveModels || ec.whisperRows < 2 || !scopedOk) {
        console.error(`[smoke] FAILED: engine-first settings wrong: ${engineCheck}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }

    // 2.8) v1.6.0 AI checkup button gating. Hidden while the feature is disabled (default);
    // visible only when enabled + configured AND a finished, diarization-resolved session is
    // open AND the pipeline is idle; hidden again while a recording status is forced.
    const btnHidden0 = await win.webContents.executeJavaScript(
      'document.getElementById("btnAiCheckup")?.classList.contains("hidden")');
    console.log('[smoke] checkup hidden (feature disabled):', btnHidden0);
    if (btnHidden0 !== true) {
      console.error('[smoke] FAILED: AI checkup button visible while the feature is disabled');
      process.exitCode = 1;
    }

    // fixture: a finished, diarized session. No audio file is needed — the gate never plays it.
    const fxParent = path.join(app.getPath('temp'), 'susurro-smoke-checkup');
    try { fs.rmSync(fxParent, { recursive: true, force: true }); } catch { /* fresh dir */ }
    fs.mkdirSync(fxParent, { recursive: true });
    const fx = store.createSession({
      parentDir: fxParent, name: 'smoke-checkup',
      settings: { model: 'small.en' }, gpu: null,
      model: { name: 'small.en', engine: 'whisper' }, chunkSec: 12, sources: [],
    });
    fx.recording.startedAt = new Date().toISOString();
    fx.recording.stoppedAt = new Date().toISOString();
    fx.recording.durationSec = 24;
    const mkWords = (n) => Array.from({ length: n }, (_, i) => ({ t: i * 0.4, d: 0.3, w: `word${i}` }));
    fx.chunks = [0, 1].map((k) => ({
      index: k, offsetSec: k * 12, durationSec: 12,
      audioFile: `audio/chunk_000${k}.wav`, status: 'done', engine: 'demo',
      words: mkWords(30),
    }));
    fx.diarization = {
      version: 1, engine: 'demo', model: 'placeholder',
      createdAt: new Date().toISOString(), audioSec: 24, speakers: 1,
      turns: [{ start: 0, end: 24, speaker: 'spk0' }],
    };
    store.writeSession(fx.folder, fx);

    // configure through the real settings store, then reload so the renderer's boot-time
    // settings fetch (S.settings) sees the fixture parent + the checkup config.
    const prevSettings = {
      llmCheckup: settings.get('llmCheckup'),
      llmEndpoint: settings.get('llmEndpoint'),
      llmApiKey: settings.get('llmApiKey'),
      llmModel: settings.get('llmModel'),
      lastSessionParent: settings.get('lastSessionParent'),
    };
    settings.set({
      llmCheckup: true,
      llmEndpoint: 'http://127.0.0.1:9/v1',
      llmModel: 'smoke-stub',
      llmApiKey: '',
      lastSessionParent: fxParent,
    });
    win.webContents.reload();
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await new Promise((r) => setTimeout(r, 1200));   // renderer boot wiring

    const gateCheck = await win.webContents.executeJavaScript(`(async () => {
      const poll = async (fn, ms = 6000) => {
        const t0 = Date.now();
        for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 150)); }
      };
      const btn = document.getElementById('btnAiCheckup');
      if (!btn) return JSON.stringify({ fail: 'no btnAiCheckup' });
      const out = {};
      out.hiddenWithNoSession = btn.classList.contains('hidden');
      document.getElementById('btnSessions')?.click();
      const item = await poll(async () => {
        const its = [...document.querySelectorAll('.sess-item')];
        return its.find((x) => /smoke-checkup/.test(x.textContent)) || null;
      });
      if (!item) return JSON.stringify({ fail: 'fixture session not listed' });
      item.click();
      const shown = await poll(() => !btn.classList.contains('hidden') || null);
      out.visibleWhenConfiguredAndResolved = !!shown;
      out.diarizeBtnShown = !document.getElementById('btnDiarize')?.classList.contains('hidden');
      return JSON.stringify(out);
    })()`);
    console.log('[smoke] checkup gate    :', gateCheck);
    try {
      const gc = JSON.parse(gateCheck);
      if (gc.fail || !gc.hiddenWithNoSession || !gc.visibleWhenConfiguredAndResolved) {
        console.error(`[smoke] FAILED: AI checkup gating wrong: ${gateCheck}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }

    // force a fake recording status through the real event path — the button must hide.
    send('recordState', { recording: true, paused: false });
    await new Promise((r) => setTimeout(r, 300));
    const hiddenWhileRecording = await win.webContents.executeJavaScript(
      'document.getElementById("btnAiCheckup").classList.contains("hidden")');
    console.log('[smoke] checkup hidden (recording)      :', hiddenWhileRecording);
    if (hiddenWhileRecording !== true) {
      console.error('[smoke] FAILED: AI checkup button visible while recording');
      process.exitCode = 1;
    }
    send('recordState', { recording: false, paused: false });
    await new Promise((r) => setTimeout(r, 300));

    // restore the user's settings and leave the gate in its default (hidden) state.
    // The renderer's S.settings is only refreshed through its own input handlers, so
    // restore THROUGH the real inputs (their change handlers persist + re-render);
    // main-side settings.set alone leaves S.settings stale (the button stayed visible).
    await win.webContents.executeJavaScript(`(async () => {
      const flip = (id, value) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox') { el.checked = value; } else { el.value = value; }
        el.dispatchEvent(new Event('change'));
      };
      flip('setLlmCheckup', false);
      flip('setLlmEndpoint', '');
      flip('setLlmModel', '');
    })()`);
    settings.set({ llmApiKey: prevSettings.llmApiKey, lastSessionParent: prevSettings.lastSessionParent });
    send('recordState', { recording: false, paused: false });
    await new Promise((r) => setTimeout(r, 300));
    const hiddenRestored = await win.webContents.executeJavaScript(
      'document.getElementById("btnAiCheckup").classList.contains("hidden")');
    console.log('[smoke] checkup hidden (restored off)   :', hiddenRestored);
    if (hiddenRestored !== true) {
      console.error('[smoke] FAILED: AI checkup button still visible after settings restore');
      process.exitCode = 1;
    }

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
app.on('will-quit', () => {
  try { diarizeRun?.child?.kill(); } catch { /* already gone */ }
  try { checkupRun?.ctrl?.abort(); } catch { /* already gone */ }
});

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
