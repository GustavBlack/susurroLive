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
const { createDiscovery } = require('./mcp/discovery');
const { createMcpServer } = require('./mcp/server');
const { createTools } = require('./mcp/tools');
const { createController } = require('./mcp/controller');
const { createRendererControl } = require('./mcp/renderer-control');

const SMOKE = process.argv.includes('--smoke');
const SMOKE_SHOW = process.argv.includes('--smoke-show');
const SMOKE_SESSION = (process.argv.find((a) => a.startsWith('--smoke-session=')) || '').split('=')[1] || null;
const SMOKE_IMPORT = process.argv.includes('--smoke-import');

// --------------------------------------------------------------------------- paths
const REPO_ROOT = path.join(__dirname, '..', '..');
const BIN_DIR = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(REPO_ROOT, 'native', 'bin');
const MODEL_DIR = app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(REPO_ROOT, 'native', 'models');
const RENDERER_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const RENDERER_URL = pathToFileURL(RENDERER_HTML).href;

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
let rendererReady = false;
let rendererControl = null;
let mcpDiscovery = null;
let mcpServer = null;

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

/** Settings patch + the in-flight session's model snapshot (shared by IPC and MCP). */
function applySettingsPatch(patch = {}) {
  const next = settings.set(patch || {});
  if (active && active.model) {
    if (patch?.model) active.model.name = patch.model;
    if (patch?.language) active.model.language = patch.language;
    if (patch?.device) active.model.device = patch.device;
    if (typeof patch?.vad === 'boolean') active.model.vad = patch.vad;
    if (patch?.engine === 'whisper' || patch?.engine === 'parakeet') active.model.engine = patch.engine;
    persist();
  }
  return next;
}

/** Create + activate a session. Shared by the IPC handler and MCP tools. */
function createSessionFor(opts = {}) {
  if (recording) return { ok: false, error: 'stop recording before creating another session' };
  if (importing) return { ok: false, error: 'wait for the import to finish' };
  try {
    const parentDir = opts.parentDir || settings.get('lastSessionParent');
    if (!parentDir) return { ok: false, error: 'no session folder chosen yet' };
    fs.mkdirSync(parentDir, { recursive: true });
    settings.set({ lastSessionParent: parentDir });
    if (opts.engine === 'whisper' || opts.engine === 'parakeet') applySettingsPatch({ engine: opts.engine });
    if (opts.language) applySettingsPatch({ language: opts.language });

    active = store.createSession({
      parentDir,
      name: opts.name || 'Session',
      settings: settings.all(),
      gpu,
      model: { name: opts.model || settings.get('model'), device: opts.device || settings.get('device') },
      chunkSec: opts.chunkSec || settings.get('chunkSec'),
      sources: opts.sources || [],
    });
    // createSession reads the engine from settings; keep the session snapshot honest.
    active.model.engine = settings.get('engine') || 'whisper';
    persist();
    pipeline = makePipeline();
    return { ok: true, session: publicSession() };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

/** Close the active session. Shared by IPC and MCP. */
function closeSession() {
  if (recording) return { ok: false, error: 'stop recording before closing the session' };
  active = null; pipeline = null;
  return { ok: true };
}

/** Export one artifact. Shared by the IPC handler and MCP; supports a non-active session. */
function runExport(kind, session = active) {
  if (!session) return { ok: false, error: 'no session' };
  if (kind === 'audio' && recording && session === active) {
    return { ok: false, error: 'stop recording before exporting audio' };
  }
  try {
    const dir = path.join(session.folder, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    let res;
    if (kind === 'txt') res = exporters.exportTxt(session, path.join(dir, 'full.txt'));
    else if (kind === 'json') res = exporters.exportJson(session, path.join(dir, 'full.json'));
    else if (kind === 'audio') res = exporters.exportAudio(session, path.join(dir, 'full.wav'), { concatWavs });
    else return { ok: false, error: `unknown export kind: ${kind}` };

    const entry = {
      kind,
      path: path.relative(session.folder, res.path).replace(/\\/g, '/'),
      at: new Date().toISOString(),
    };
    if (!Array.isArray(session.exports)) session.exports = [];
    session.exports.push(entry);
    if (session === active) persist();
    else store.updateSessionFile(session.folder, (s) => {
      if (!Array.isArray(s.exports)) s.exports = [];
      s.exports.push(entry);
    });
    return { ok: true, path: res.path, bytes: res.bytes };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

/** Import audio/video into a session. Shared by IPC and MCP. */
async function runImport({ mediaPath, parentDir, name } = {}) {
  try {
    if (!mediaPath || !fs.existsSync(mediaPath)) return { ok: false, error: 'media file not found' };
    const ext = path.extname(mediaPath).slice(1).toLowerCase();
    if (!ffmpegBridge.MEDIA_EXTS.has(ext)) return { ok: false, error: `unsupported file type .${ext}` };
    const ffmpegPath = ffmpegBridge.findFfmpeg(REPO_ROOT, BIN_DIR);
    if (!ffmpegPath) return { ok: false, error: 'ffmpeg not found - put ffmpeg.exe in native/bin or on PATH' };
    const parent = parentDir || settings.get('lastSessionParent');
    if (!parent) return { ok: false, error: 'no session folder chosen yet' };
    if (recording) return { ok: false, error: 'stop recording before importing' };
    fs.mkdirSync(parent, { recursive: true });
    settings.set({ lastSessionParent: parent });

    importing = true;
    active = store.createSession({
      parentDir: parent,
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
    if (pipeline) pipeline.enqueueAllOutstanding();
    send('status', { importing: false });
    return { ok: true, session: publicSession(), seconds: r.seconds, chunks: r.chunks };
  } catch (err) {
    importing = false;
    return { ok: false, error: String(err.message || err) };
  }
}

function getDiarizeStatus() {
  return {
    ...diarizer.status({ repoRoot: REPO_ROOT, binDir: BIN_DIR, modelDir: MODEL_DIR }),
    running: diarizeRun ? diarizeRun.folder : null,
  };
}

/** Start/stop/restart the MCP listener after a settings change or at boot. */
async function applyMcpSettings() {
  if (!mcpServer) return null;
  const enabled = settings.get('mcpEnabled') !== false;
  await mcpServer.stop();
  if (!enabled) {
    const info = mcpServer.info();
    send('mcpStatus', { ...info, enabled: false });
    return { ...info, enabled: false };
  }
  const port = Number(settings.get('mcpPort'));
  const r = await mcpServer.start(Number.isFinite(port) && port >= 0 ? port : 8790);
  send('mcpStatus', r);
  return r;
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
/** Pre-paint flash color: Tech Moca's floor for the persisted mode (theme/tech-moca.css). */
function themeBackgroundColor() {
  return settings?.get('themeMode') === 'light' ? '#ece9e2' : '#141414';
}

function createWindow() {
  win = new BrowserWindow({
    width: 820,
    height: 1040,
    minWidth: 680,
    minHeight: 880,
    backgroundColor: themeBackgroundColor(),
    title: 'susurroLive',
    // Hidden title bar, not frame:false: Windows keeps edge resize, shadow,
    // Win11 rounded corners, drag snap and Win+arrow. The header draws the controls.
    titleBarStyle: 'hidden',
    icon: app.isPackaged ? undefined : path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    show: !SMOKE || SMOKE_SHOW,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // An agent may record while the window is minimized/occluded; keep the capture graph
      // and chunk timer running instead of letting Chromium throttle them.
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(RENDERER_HTML);

  // Frameless window: push the maximize/focus state so the renderer's glyph stays
  // correct after a snap, Win+arrow, double-click or system restore.
  const sendWindowState = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('evt:windowState', {
      maximized: win.isMaximized(),
      focused: win.isFocused(),
    });
  };
  win.on('maximize', sendWindowState);
  win.on('unmaximize', sendWindowState);
  win.on('restore', sendWindowState);
  win.on('focus', sendWindowState);
  win.on('blur', sendWindowState);

  // autoHideMenuBar removes the menu accelerators; keep DevTools reachable.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  win.webContents.on('did-start-loading', () => {
    rendererReady = false;
    if (rendererControl) rendererControl.reset('susurroLive UI is reloading; retry when it is ready');
  });
  win.webContents.on('render-process-gone', () => {
    rendererReady = false;
    if (rendererControl) rendererControl.reset('susurroLive renderer process is gone');
    // The capture graph is gone with the renderer. Finalize what was written so the session
    // is not left looking like an active recording.
    if (recording && recorder) {
      try { recorder.stop(); } catch { /* already stopped */ }
      recorder = null;
      recording = false;
      if (active) {
        active.recording.stoppedAt = new Date().toISOString();
        active.recording.durationSec = Number(
          active.chunks.reduce((n, c) => n + (c.durationSec || 0), 0).toFixed(2),
        );
        persist();
        if (pipeline) pipeline.enqueueAllOutstanding();
      }
    }
  });
  // Right-click anywhere: the one folder the user owns is the sessions root (v1.5.1).
  win.webContents.on('context-menu', () => {
    const dir = settings.get('lastSessionParent');
    Menu.buildFromTemplate([{
      label: 'Open Sessions Folder',
      enabled: !!dir,
      click: () => { if (dir) void shell.openPath(dir); },
    }]).popup({ window: win });
  });
  win.on('closed', () => {
    win = null;
    rendererReady = false;
    if (rendererControl) rendererControl.reset('susurroLive window closed');
  });
  return win;
}

// --------------------------------------------------------------------------- ipc
function registerIpc() {
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:paths', () => ({
    repo: REPO_ROOT, bin: BIN_DIR, models: MODEL_DIR, userData: app.getPath('userData'),
  }));

  // Frameless window controls. Only our own page, in our own window, may act:
  // check the sender's frame and URL, never a renderer-supplied id (§10.16).
  const senderWindow = (event) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return null;
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null || frame.url !== RENDERER_URL) return null;
    return win;
  };
  ipcMain.handle('window:minimize', (event) => {
    const w = senderWindow(event);
    if (w) w.minimize();
  });
  ipcMain.handle('window:toggleMaximize', (event) => {
    const w = senderWindow(event);
    if (!w) return false;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    return w.isMaximized();
  });
  ipcMain.handle('window:close', (event) => {
    const w = senderWindow(event);
    if (w) w.close();
  });
  ipcMain.handle('window:state', (event) => {
    const w = senderWindow(event);
    return w ? { maximized: w.isMaximized(), focused: w.isFocused() } : null;
  });

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
  ipcMain.handle('settings:set', async (_e, patch) => {
    const next = applySettingsPatch(patch || {});
    if (patch && ('mcpEnabled' in patch || 'mcpPort' in patch)) await applyMcpSettings();
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

  ipcMain.handle('session:create', (_e, opts = {}) => createSessionFor(opts));

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
  ipcMain.handle('session:close', () => closeSession());

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

  ipcMain.handle('import:run', (_e, { mediaPath, name } = {}) => runImport({ mediaPath, name }));


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
  ipcMain.handle('export:run', (_e, kind) => runExport(kind));

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
  ipcMain.handle('diarize:status', () => getDiarizeStatus());
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
    // v1.9.2: the checkup may run LIVE — recording and chunks still in flight are fine, it
    // checks whatever words exist at click time (runCheckup snapshots them). Only the import
    // decode phase and a diarize run still hold it off.
    if (importing) return { ok: false, error: 'wait for the import to finish' };
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

  // -------- renderer readiness + local agent (MCP) control surface --------
  ipcMain.on('app:ready', (event) => {
    if (!win || event.sender !== win.webContents) return;
    rendererReady = true;
    if (rendererControl) rendererControl.markReady();
  });

  ipcMain.handle('mcp:status', () => ({
    ...(mcpServer ? mcpServer.info() : { running: false, url: null, port: null, error: null, toolCount: 0, tools: [] }),
    enabled: settings.get('mcpEnabled') !== false,
    discoveryPath: mcpDiscovery?.file || null,
  }));
  ipcMain.handle('mcp:copyConfig', () => {
    try {
      if (!mcpServer) return { ok: false, error: 'MCP server is not initialized' };
      clipboard.writeText(mcpServer.hermesConfig());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('mcp:rotateToken', () => {
    try {
      if (!mcpServer) return { ok: false, error: 'MCP server is not initialized' };
      const info = mcpServer.rotateToken();
      send('mcpStatus', info);
      return { ok: true, ...info };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('mcp:reveal', () => {
    try {
      if (!mcpDiscovery) return { ok: false, error: 'MCP discovery is not initialized' };
      shell.showItemInFolder(mcpDiscovery.file);
      return { ok: true, path: mcpDiscovery.file };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
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

  rendererControl = createRendererControl({ ipcMain, getWindow: () => win });
  mcpDiscovery = createDiscovery({ userDataDir: app.getPath('userData'), version: app.getVersion() });
  mcpDiscovery.ensure();
  const mcpController = createController({
    appVersion: app.getVersion(),
    settings, store, exporters, gpu,
    getActive: () => active,
    getPipeline: () => pipeline,
    getRecorder: () => recorder,
    isRecording: () => recording,
    isImporting: () => importing,
    getRendererReady: () => rendererReady,
    rendererControl,
    desktopCapturer,
    send,
    persist,
    activateSession,
    createSessionFor,
    runExport,
    runImport,
    diarizeActive,
    getDiarizeStatus,
    getEngineStatus: () => engineSelector.status(),
    getMcpInfo: () => (mcpServer ? mcpServer.info() : null),
    applySettingsPatch,
  });
  mcpServer = createMcpServer({
    version: app.getVersion(),
    tools: createTools(mcpController),
    discovery: mcpDiscovery,
  });

  registerIpc();

  // Optional: preload a session so the renderer boots straight into real content (smoke/dev).
  if (SMOKE_SESSION) {
    const r = activateSession(SMOKE_SESSION);
    console.log('[susurroLive] preloaded session:', r.ok ? r.session.name : r.error);
  }

  createWindow();
  void applyMcpSettings();

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

    // Snapshot the engine BEFORE any stage runs: the engine-first stage flips the select
    // (and the renderer persists whisper), so capturing it later would record the flip as
    // the user's choice and the end-of-smoke restore would write whisper back to real settings.
    const engineAtStart = settings.get('engine');
    const themeAtStart = settings.get('theme');
    const themeModeAtStart = settings.get('themeMode');

    // Smoke artifacts live in the repo during dev; a packaged build has no repo,
    // so land them in temp instead (the asar is not a writable directory).
    const smokeDir = app.isPackaged ? app.getPath('temp') : path.join(REPO_ROOT, 'native');
    const smokePath = (name) => path.join(smokeDir, name);

    // 1) main view
    let img = await win.webContents.capturePage();
    const out = smokePath('_smoke.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, img.toPNG());

    // 2) settings: a floating window with tabs. boot/wire is async, so poll until
    //    the window is actually visible before capturing.
    let settingsGeom = '';
    for (let i = 0; i < 50 && !/true/.test(settingsGeom); i++) {
      await win.webContents.executeJavaScript("document.getElementById('btnSettings')?.click()");
      await new Promise((r) => setTimeout(r, 200));
      settingsGeom = await win.webContents.executeJavaScript(
        '(() => { const w = document.getElementById("settingsWindow");' +
        ' const b = document.getElementById("settingsDrawer");' +
        ' const r = w.getBoundingClientRect();' +
        ' const tabs = [...document.querySelectorAll(".settings-tab")].map(t => t.id);' +
        ' const active = document.querySelector(".settings-tab.is-active")?.id || "";' +
        ' const engineOpen = !document.getElementById("panel-engine").classList.contains("hidden");' +
        ' const othersClosed = ["transcription","appearance","checkup","agents","about"].every(t => document.getElementById("panel-" + t).classList.contains("hidden"));' +
        ' return JSON.stringify({ open: !b.classList.contains("hidden"), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight, tabs, active, engineOpen, othersClosed }); })()');
    }
    console.log('[smoke] settings window:', settingsGeom);
    try {
      const sg = JSON.parse(settingsGeom);
      const centered = Math.abs(sg.x + sg.w / 2 - sg.vw / 2) < 4 && Math.abs(sg.y + sg.h / 2 - sg.vh / 2) < 4;
      const floating = sg.open && sg.w <= sg.vw - 16 && sg.h <= sg.vh - 16 && centered;
      const tabsOk = sg.tabs.length === 6 && sg.active === 'tab-engine' && sg.engineOpen && sg.othersClosed;
      if (!floating || !tabsOk) {
        console.error(`[smoke] FAILED: settings window wrong: ${settingsGeom}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }
    const overlayDrag = await win.webContents.executeJavaScript(`JSON.stringify({
      backdrop: getComputedStyle(document.getElementById('settingsDrawer')).getPropertyValue('-webkit-app-region'),
      win: getComputedStyle(document.getElementById('settingsWindow')).getPropertyValue('-webkit-app-region'),
    })`);
    console.log('[smoke] overlay drag:', overlayDrag);
    try {
      const od = JSON.parse(overlayDrag);
      if (od.backdrop !== 'drag' || od.win !== 'no-drag') {
        console.error(`[smoke] FAILED: dialog drag regions wrong: ${overlayDrag}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }
    const hitTest = await win.webContents.executeJavaScript(
      '(() => { const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);' +
      ' return el ? (el.id || el.className || el.tagName) : "none"; })()');
    console.log('[smoke] hit @center:', hitTest);

    // 2.1) v1.9.1 frameless window: Tech Moca §10.16 chrome (tm-titlebar drag
    // strip, tm-window-controls fixed at the window's top right, 26 px faces,
    // hairline glyphs, controls above overlays).
    const frameCheck = await win.webContents.executeJavaScript(`JSON.stringify((() => {
      const bar = document.querySelector('.tm-titlebar');
      const controls = document.querySelector('.tm-window-controls');
      const face = document.querySelector('#btnMaximize .tm-window-face');
      const cr = controls?.getBoundingClientRect();
      return {
        min: !!document.getElementById('btnMinimize'),
        max: !!document.getElementById('btnMaximize'),
        close: !!document.getElementById('btnCloseWindow'),
        drag: bar ? getComputedStyle(bar).getPropertyValue('-webkit-app-region') : '',
        btnDrag: getComputedStyle(document.getElementById('btnSettings')).getPropertyValue('-webkit-app-region'),
        controls: !!controls,
        fixed: controls ? getComputedStyle(controls).position : '',
        z: controls ? getComputedStyle(controls).zIndex : '',
        top: cr ? Math.round(cr.top) : -1,
        right: cr ? Math.round(cr.right) : -1,
        vw: innerWidth,
        face: face ? Math.round(face.getBoundingClientRect().width) : -1,
        glyphs: document.querySelectorAll('.tm-window-button svg').length,
      };
    })())`);
    console.log('[smoke] window chrome:', frameCheck);
    try {
      const fc = JSON.parse(frameCheck);
      const chromeOk = fc.min && fc.max && fc.close && fc.controls
        && fc.drag === 'drag' && fc.btnDrag === 'no-drag' && fc.fixed === 'fixed' && fc.z === '70'
        && fc.top === 0 && fc.right === fc.vw && fc.face === 26 && fc.glyphs === 3;
      if (!chromeOk) {
        console.error(`[smoke] FAILED: frameless chrome wrong: ${frameCheck}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }
    console.log('[smoke] frameless    :', typeof win.isFrameless === 'function' ? win.isFrameless() : 'n/a');
    const maxBefore = win.isMaximized();
    await win.webContents.executeJavaScript("document.getElementById('btnMaximize').click()");
    await new Promise((r) => setTimeout(r, 400));
    const maxAfter = win.isMaximized();
    const maxState = await win.webContents.executeJavaScript(`JSON.stringify({
      label: document.getElementById('btnMaximize').getAttribute('aria-label'),
      data: document.querySelector('.tm-window-controls')?.dataset.maximized,
    })`);
    await win.webContents.executeJavaScript("document.getElementById('btnMaximize').click()");
    await new Promise((r) => setTimeout(r, 400));
    const maxRestored = win.isMaximized();
    const restoredState = await win.webContents.executeJavaScript(`JSON.stringify({
      label: document.getElementById('btnMaximize').getAttribute('aria-label'),
      data: document.querySelector('.tm-window-controls')?.dataset.maximized,
    })`);
    console.log('[smoke] window max   :', JSON.stringify({ maxBefore, maxAfter, maxRestored, maxState, restoredState }));
    if (maxBefore === maxAfter || maxAfter === maxRestored) {
      console.error('[smoke] FAILED: maximize/restore did not toggle the window state');
      process.exitCode = 1;
    }
    try {
      const a = JSON.parse(maxState);
      const b = JSON.parse(restoredState);
      if (a.label !== 'Restore' || a.data !== 'true' || b.label !== 'Maximize' || b.data !== 'false') {
        console.error('[smoke] FAILED: maximize/restore glyph state did not follow the window');
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }
    win.unmaximize();
    win.setSize(820, 1040);
    await new Promise((r) => setTimeout(r, 300));
    await win.webContents.executeJavaScript("document.getElementById('btnMinimize').click()");
    await new Promise((r) => setTimeout(r, 400));
    const minAfter = win.isMinimized();
    console.log('[smoke] window min   :', JSON.stringify({ minAfter }));
    win.restore();
    await new Promise((r) => setTimeout(r, 300));

    // Every tab must activate its own panel and only its own panel.
    const tabCheck = await win.webContents.executeJavaScript(`(async () => {
      const out = [];
      for (const id of ['transcription','appearance','checkup','agents','about','engine']) {
        document.getElementById('tab-' + id).click();
        await new Promise((r) => setTimeout(r, 60));
        const active = document.querySelector('.settings-tab.is-active')?.id || '';
        const visible = [...document.querySelectorAll('.settings-panel')]
          .filter((p) => !p.classList.contains('hidden')).map((p) => p.id);
        const st = getComputedStyle(document.getElementById('tab-' + id));
        out.push({ id, active, visible, outline: st.outlineStyle + ' ' + st.outlineWidth, borderRight: st.borderRightWidth, shadow: st.boxShadow });
      }
      return JSON.stringify(out);
    })()`);
    console.log('[smoke] settings tabs:', tabCheck);
    try {
      const tc = JSON.parse(tabCheck);
      const ok = tc.length === 6 && tc.every((t) => t.active === `tab-${t.id}` && t.visible.length === 1 && t.visible[0] === `panel-${t.id}`);
      if (!ok) {
        console.error(`[smoke] FAILED: settings tab switching wrong: ${tabCheck}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }
    await new Promise((r) => setTimeout(r, 400));
    img = await win.webContents.capturePage();
    const out2 = smokePath('_smoke_settings.png');
    fs.writeFileSync(out2, img.toPNG());
    // Artifact per tab: each panel must lay out without clipping or overflow.
    for (const id of ['transcription', 'checkup', 'agents', 'about']) {
      await win.webContents.executeJavaScript(`document.getElementById('tab-${id}').click()`);
      await new Promise((r) => setTimeout(r, 250));
      img = await win.webContents.capturePage();
      fs.writeFileSync(smokePath(`_smoke_tab_${id}.png`), img.toPNG());
    }
    await win.webContents.executeJavaScript("document.getElementById('tab-engine').click()");
    // Arrow keys move between tabs, as the tablist promises.
    const arrowCheck = await win.webContents.executeJavaScript(`(async () => {
      document.getElementById('tab-engine').focus();
      const list = document.getElementById('tab-engine').parentElement;
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      const right = document.querySelector('.settings-tab.is-active')?.id || '';
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      const left = document.querySelector('.settings-tab.is-active')?.id || '';
      return JSON.stringify({ right, left });
    })()`);
    console.log('[smoke] arrow keys :', arrowCheck);
    try {
      const ac = JSON.parse(arrowCheck);
      if (ac.right !== 'tab-transcription' || ac.left !== 'tab-engine') {
        console.error(`[smoke] FAILED: arrow-key tab navigation wrong: ${arrowCheck}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }
    // Escape closes the floating window and returns focus to the Settings button.
    const escapeCheck = await win.webContents.executeJavaScript(`(async () => {
      const btn = document.getElementById('btnSettings');
      btn.focus();
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      const opened = !document.getElementById('settingsDrawer').classList.contains('hidden');
      document.getElementById('settingsWindow').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return JSON.stringify({
        opened,
        closed: document.getElementById('settingsDrawer').classList.contains('hidden'),
        focus: document.activeElement?.id || '',
      });
    })()`);
    console.log('[smoke] escape/focus:', escapeCheck);
    try {
      const ec = JSON.parse(escapeCheck);
      if (!ec.opened || !ec.closed || ec.focus !== 'btnSettings') {
        console.error(`[smoke] FAILED: Escape/focus return wrong: ${escapeCheck}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }
    await win.webContents.executeJavaScript("document.getElementById('btnSettings').click()");
    await new Promise((r) => setTimeout(r, 300));
    // Sessions modal artifact: the library surface must lay out with words when empty.
    await win.webContents.executeJavaScript("document.getElementById('btnSessions').click()");
    await new Promise((r) => setTimeout(r, 500));
    img = await win.webContents.capturePage();
    fs.writeFileSync(smokePath('_smoke_sessions.png'), img.toPNG());
    await win.webContents.executeJavaScript("document.getElementById('btnCloseSessions').click()");
    await new Promise((r) => setTimeout(r, 300));
    // End-session confirm artifact: danger styling, Cancel first, action-named button.
    await win.webContents.executeJavaScript("document.getElementById('endConfirm').classList.remove('hidden')");
    await new Promise((r) => setTimeout(r, 300));
    img = await win.webContents.capturePage();
    fs.writeFileSync(smokePath('_smoke_end.png'), img.toPNG());
    await win.webContents.executeJavaScript("document.getElementById('endConfirm').classList.add('hidden')");

    // 2.5) v1.8 appearance: Tech Moca is the only palette; dark/light persists.
    const modeCheck = await win.webContents.executeJavaScript(`(async () => {
      const tab = document.getElementById('tab-appearance');
      if (!tab) return JSON.stringify({ fail: 'no appearance tab' });
      tab.click();
      await new Promise((r) => setTimeout(r, 120));
      const light = [...document.querySelectorAll('#modeList .seg-btn')].find((b) => /light/i.test(b.textContent));
      const dark = [...document.querySelectorAll('#modeList .seg-btn')].find((b) => /dark/i.test(b.textContent));
      if (!light || !dark) return JSON.stringify({ fail: 'no mode control rendered' });
      dark.click();                              // start from a known state
      await new Promise((r) => setTimeout(r, 300));
      light.click();
      await new Promise((r) => setTimeout(r, 120));   // inside the 180 ms fade window
      const html = document.documentElement;
      const midAnim = html.classList.contains('mode-anim');
      const bg = getComputedStyle(html).getPropertyValue('--tm-bg').trim();
      const accent = getComputedStyle(html).getPropertyValue('--tm-accent').trim();
      const theme = html.dataset.theme;
      await new Promise((r) => setTimeout(r, 300));   // past the 180 ms cleanup
      return JSON.stringify({ theme, mode: html.dataset.themeMode, midAnim, animCleared: !html.classList.contains('mode-anim'), bg, accent });
    })()`);
    console.log('[smoke] mode swap    :', modeCheck);
    try {
      const mc = JSON.parse(modeCheck);
      if (mc.fail || mc.theme !== 'tech-moca' || mc.mode !== 'light' || !mc.midAnim || !mc.animCleared || !/^#ece9e2$/i.test(mc.bg)) {
        console.error(`[smoke] FAILED: mode swap state wrong: ${modeCheck}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }
    const modePersisted = (() => { try { return JSON.parse(fs.readFileSync(settings.file, 'utf8')).themeMode; } catch { return null; } })();
    console.log('[smoke] mode persisted:', modePersisted);
    if (modePersisted !== 'light') {
      console.error('[smoke] FAILED: appearance mode not persisted to settings.json');
      process.exitCode = 1;
    }
    img = await win.webContents.capturePage();
    fs.writeFileSync(smokePath('_smoke_light.png'), img.toPNG());
    // Main view in light mode, without the settings surface.
    await win.webContents.executeJavaScript("document.getElementById('btnCloseSettings').click()");
    await new Promise((r) => setTimeout(r, 400));
    img = await win.webContents.capturePage();
    fs.writeFileSync(smokePath('_smoke_light_main.png'), img.toPNG());
    await win.webContents.executeJavaScript("document.getElementById('btnSettings').click()");
    await new Promise((r) => setTimeout(r, 300));
    // restore dark so the remaining artifact shots stay canonical
    await win.webContents.executeJavaScript(`(async () => {
      const dark = [...document.querySelectorAll('#modeList .seg-btn')].find((b) => /dark/i.test(b.textContent));
      if (dark) { dark.click(); await new Promise((r) => setTimeout(r, 300)); }
      document.getElementById('tab-engine')?.click();
    })()`);

    // 2.5b) v1.9 skins: chroma-only swap, persistence, both modes, restore Tech Moca.
    const skinCheck = await win.webContents.executeJavaScript(`(async () => {
      document.getElementById('tab-appearance')?.click();
      await new Promise((r) => setTimeout(r, 120));
      const rows = [...document.querySelectorAll('#skinList .skin-row')];
      const midnight = rows.find((r) => r.dataset.skin === 'midnight');
      const tech = rows.find((r) => r.dataset.skin === '');
      if (!midnight || !tech) return JSON.stringify({ fail: 'skin rows missing', rows: rows.length });
      midnight.click();
      await new Promise((r) => setTimeout(r, 120));
      const html = document.documentElement;
      const midAnim = html.classList.contains('skin-anim');
      const accent = getComputedStyle(html).getPropertyValue('--tm-accent').trim();
      const skin = html.dataset.skin;
      await new Promise((r) => setTimeout(r, 300));
      const animCleared = !html.classList.contains('skin-anim');
      return JSON.stringify({ rows: rows.length, skin, accent, midAnim, animCleared });
    })()`);
    console.log('[smoke] skin swap    :', skinCheck);
    try {
      const sc = JSON.parse(skinCheck);
      if (sc.fail || sc.rows !== 12 || sc.skin !== 'midnight' || !/^#5aa9ff$/i.test(sc.accent) || !sc.midAnim || !sc.animCleared) {
        console.error(`[smoke] FAILED: skin swap wrong: ${skinCheck}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }
    const skinPersisted = (() => { try { return JSON.parse(fs.readFileSync(settings.file, 'utf8')).theme; } catch { return null; } })();
    console.log('[smoke] skin persisted:', skinPersisted);
    if (skinPersisted !== 'midnight') {
      console.error('[smoke] FAILED: skin not persisted to settings.json');
      process.exitCode = 1;
    }
    img = await win.webContents.capturePage();
    fs.writeFileSync(smokePath('_smoke_skin_dark.png'), img.toPNG());

    const skinLight = await win.webContents.executeJavaScript(`(async () => {
      const light = [...document.querySelectorAll('#modeList .seg-btn')].find((b) => /light/i.test(b.textContent));
      light.click();
      await new Promise((r) => setTimeout(r, 300));
      const html = document.documentElement;
      return JSON.stringify({ skin: html.dataset.skin, mode: html.dataset.themeMode, accent: getComputedStyle(html).getPropertyValue('--tm-accent').trim() });
    })()`);
    console.log('[smoke] skin light   :', skinLight);
    try {
      const sl = JSON.parse(skinLight);
      if (sl.skin !== 'midnight' || sl.mode !== 'light' || !/^#2563eb$/i.test(sl.accent)) {
        console.error(`[smoke] FAILED: skin light mode wrong: ${skinLight}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }
    img = await win.webContents.capturePage();
    fs.writeFileSync(smokePath('_smoke_skin_light.png'), img.toPNG());

    const skinRestore = await win.webContents.executeJavaScript(`(async () => {
      const dark = [...document.querySelectorAll('#modeList .seg-btn')].find((b) => /dark/i.test(b.textContent));
      dark.click();
      await new Promise((r) => setTimeout(r, 300));
      const tech = [...document.querySelectorAll('#skinList .skin-row')].find((r) => r.dataset.skin === '');
      tech.click();
      await new Promise((r) => setTimeout(r, 300));
      const html = document.documentElement;
      return JSON.stringify({ skin: html.dataset.skin, mode: html.dataset.themeMode, accent: getComputedStyle(html).getPropertyValue('--tm-accent').trim() });
    })()`);
    console.log('[smoke] skin restore :', skinRestore);
    try {
      const sr = JSON.parse(skinRestore);
      if (sr.skin !== '' || sr.mode !== 'dark' || !/^#e6e3de$/i.test(sr.accent)) {
        console.error(`[smoke] FAILED: skin restore wrong: ${skinRestore}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }
    const skinRestored = (() => { try { return JSON.parse(fs.readFileSync(settings.file, 'utf8')).theme; } catch { return null; } })();
    console.log('[smoke] skin restored:', skinRestored);
    if (skinRestored !== '') {
      console.error('[smoke] FAILED: Tech Moca skin not persisted');
      process.exitCode = 1;
    }

    // 2.6) About block: manual update check must give inline feedback (in dev the
    // feed is unconfigured, so the expected result is the portable/dev notice).
    const aboutCheck = await win.webContents.executeJavaScript(`(async () => {
      document.getElementById('tab-about')?.click();
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
      document.getElementById('tab-engine')?.click();
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

    // 2.8) AI checkup button gating (v1.9.2 live rules). Hidden while the feature is disabled
    // (default); visible when enabled + configured AND the open session has transcribed words.
    // Diarization no longer gates it, and it stays visible while recording: the checkup runs
    // live over the words that exist so far.
    const btnHidden0 = await win.webContents.executeJavaScript(
      'document.getElementById("btnAiCheckup")?.classList.contains("hidden")');
    console.log('[smoke] checkup hidden (feature disabled):', btnHidden0);
    if (btnHidden0 !== true) {
      console.error('[smoke] FAILED: AI checkup button visible while the feature is disabled');
      process.exitCode = 1;
    }

    // fixture: a finished, diarized session (diarization is no longer required by the gate).
    // No audio file is needed — the gate never plays it.
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
      engine: engineAtStart,
      theme: themeAtStart,
      themeMode: themeModeAtStart,
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
      out.visibleWhenConfigured = !!shown;
      out.diarizeBtnShown = !document.getElementById('btnDiarize')?.classList.contains('hidden');
      return JSON.stringify(out);
    })()`);
    console.log('[smoke] checkup gate    :', gateCheck);
    try {
      const gc = JSON.parse(gateCheck);
      if (gc.fail || !gc.hiddenWithNoSession || !gc.visibleWhenConfigured) {
        console.error(`[smoke] FAILED: AI checkup gating wrong: ${gateCheck}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }

    // 2.8b) regression, v1.9.2: diarization no longer gates the checkup. A finished session
    // with NO diarization block must show the button right away (the 1.6.0 gate kept it hidden
    // until diarization resolved), and a diarization that finishes IN THE OPEN WINDOW — main
    // pushes the block identity on the transcript event — must not hide it again.
    const fxB = store.createSession({
      parentDir: fxParent, name: 'smoke-checkup-inwindow',
      settings: { model: 'small.en' }, gpu: null,
      model: { name: 'small.en', engine: 'whisper' }, chunkSec: 12, sources: [],
    });
    fxB.recording.startedAt = new Date().toISOString();
    fxB.recording.stoppedAt = new Date().toISOString();
    fxB.recording.durationSec = 24;
    fxB.chunks = [0, 1].map((k) => ({
      index: k, offsetSec: k * 12, durationSec: 12,
      audioFile: `audio/chunk_000${k}.wav`, status: 'done', engine: 'demo',
      words: mkWords(30),
    }));
    store.writeSession(fxB.folder, fxB);

    const beforeDiar = await win.webContents.executeJavaScript(`(async () => {
      const poll = async (fn, ms = 6000) => {
        const t0 = Date.now();
        for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 150)); }
      };
      document.getElementById('btnSessions')?.click();
      const item = await poll(async () => [...document.querySelectorAll('.sess-item')]
        .find((x) => /smoke-checkup-inwindow/.test(x.textContent)) || null);
      if (!item) return JSON.stringify({ fail: 'fixture not listed' });
      item.click();
      await poll(() => (document.getElementById('transcript')?.children.length || 0) > 0 || null);
      await new Promise((r) => setTimeout(r, 400));
      return JSON.stringify({
        hidden: document.getElementById('btnAiCheckup').classList.contains('hidden'),
      });
    })()`);
    let bd = {};
    try { bd = JSON.parse(beforeDiar); } catch { bd = { fail: String(beforeDiar) }; }
    console.log('[smoke] checkup visible (no diar)      :', bd.hidden === false, bd.fail ? `(${bd.fail})` : '');
    if (bd.fail || bd.hidden !== false) {
      console.error(`[smoke] FAILED: AI checkup button hidden on a finished, non-diarized session: ${beforeDiar}`);
      process.exitCode = 1;
    }

    // Same session, real event path: main pushes the finished block on the transcript channel.
    send('transcript', {
      words: mkWords(60),
      segments: [],
      fullText: 'smoke in-window diarization',
      wordSpeakers: [],
      diarization: { speakers: 1, createdAt: new Date().toISOString() },
    });
    await new Promise((r) => setTimeout(r, 400));
    const afterDiar = await win.webContents.executeJavaScript(
      'document.getElementById("btnAiCheckup").classList.contains("hidden")');
    console.log('[smoke] checkup visible (diar done)    :', afterDiar === false);
    if (afterDiar !== false) {
      console.error('[smoke] FAILED: AI checkup button vanished after an in-window diarization');
      process.exitCode = 1;
    }

    // force a fake recording status through the real event path — the button must STAY visible:
    // v1.9.2 runs the checkup live over the words that exist so far.
    send('recordState', { recording: true, paused: false });
    await new Promise((r) => setTimeout(r, 300));
    const visibleWhileRecording = await win.webContents.executeJavaScript(
      'document.getElementById("btnAiCheckup").classList.contains("hidden") === false');
    console.log('[smoke] checkup visible (recording)    :', visibleWhileRecording);
    if (visibleWhileRecording !== true) {
      console.error('[smoke] FAILED: AI checkup button hidden while recording (live-checkup regression)');
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
      flip('setLlmCheckup', ${prevSettings.llmCheckup === true});
      flip('setLlmEndpoint', ${JSON.stringify(prevSettings.llmEndpoint || '')});
      flip('setLlmModel', ${JSON.stringify(prevSettings.llmModel || '')});
      // Restore the user's real appearance through the pickers (their handlers persist).
      const mode = ${JSON.stringify(prevSettings.themeMode || 'dark')};
      const skin = ${JSON.stringify(prevSettings.theme === 'default' ? 'warm' : (prevSettings.theme || ''))};
      const modeBtn = [...document.querySelectorAll('#modeList .seg-btn')].find((b) => b.textContent.toLowerCase() === mode);
      if (modeBtn) { modeBtn.click(); await new Promise((r) => setTimeout(r, 300)); }
      const skinRow = [...document.querySelectorAll('#skinList .skin-row')].find((r) => r.dataset.skin === skin);
      if (skinRow) { skinRow.click(); await new Promise((r) => setTimeout(r, 300)); }
      // The engine is restored through the STORE, not the select: in dev an unprovisioned
      // parakeet makes the select's handler offer a 510 MB download instead of persisting.
    })()`);
    settings.set({ engine: prevSettings.engine || 'whisper', llmApiKey: prevSettings.llmApiKey, lastSessionParent: prevSettings.lastSessionParent });
    send('recordState', { recording: false, paused: false });
    await new Promise((r) => setTimeout(r, 300));
    // The restore must put back the USER's real checkup config — this smoke runs against the
    // same userData, so the expected button state depends on what was configured beforehand.
    // (It used to force blanks, which silently wiped a real endpoint/model on every smoke run.)
    const expectHiddenAfterRestore = !(prevSettings.llmCheckup === true
      && prevSettings.llmEndpoint && prevSettings.llmModel);
    const hiddenRestored = await win.webContents.executeJavaScript(
      'document.getElementById("btnAiCheckup").classList.contains("hidden")');
    console.log('[smoke] checkup hidden (after restore)  :', hiddenRestored,
      '| expected:', expectHiddenAfterRestore);
    if (hiddenRestored !== expectHiddenAfterRestore) {
      console.error('[smoke] FAILED: AI checkup button state after restore does not match the pre-smoke config');
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
    win.setSize(680, 880);
    await new Promise((r) => setTimeout(r, 1100));
    // Minimum window size: no horizontal scroll anywhere.
    const minGeom = await win.webContents.executeJavaScript(
      'JSON.stringify({ vw: innerWidth, vh: innerHeight, docSw: document.documentElement.scrollWidth, bodySw: document.body.scrollWidth })',
    );
    console.log('[smoke] min window  :', minGeom);
    try {
      const mg = JSON.parse(minGeom);
      if (mg.docSw > mg.vw || mg.bodySw > mg.vw) {
        console.error(`[smoke] FAILED: horizontal scroll at the minimum window size: ${minGeom}`);
        process.exitCode = 1;
      }
    } catch { /* non-fatal */ }
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
  if (mcpServer) void mcpServer.stop();
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
