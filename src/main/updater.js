'use strict';
/**
 * In-app auto-update for the NSIS-installed app (electron-updater, GitHub Releases feed).
 *
 * Active ONLY when: the app is packaged AND an app-update.yml sits beside the exe — i.e. a real
 * NSIS installation. Dev runs and portable exe launches are inert (no feed config there).
 *
 * Consent-first: updates are DETECTED automatically but never downloaded without a click,
 * matching the app's pattern for large payloads (models, parakeet). Events flow to the renderer
 * as `updateStatus` {state, info}:
 *   available     — a newer version exists (info: version, releaseNotes)
 *   checking / not-available
 *   downloading   — progress {pct, mbps}
 *   downloaded    — ready; renderer shows "Restart to update"
 *   error
 *
 * Feed note: the public repo feed needs no token. When building against a private fork,
 * electron-updater accepts a read token via the GH_TOKEN environment variable (set by a
 * launcher/shortcut) or a `gh-token` file next to the app's userData. See docs/installer.md.
 */
const fs = require('fs');
const path = require('path');

let autoUpdater = null; // loaded lazily: dev machines without electron-updater stay happy

function feedConfigured() {
  // electron-builder writes app-update.yml into resources/ for nsis builds only.
  try {
    const { app } = require('electron');
    if (!app.isPackaged) return false;
    return fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  } catch {
    return false;
  }
}

/** Optional read token (only needed for a private fork feed): env first, then <userData>/gh-token. */
function resolveToken(userDataDir) {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const p = path.join(userDataDir, 'gh-token');
    if (fs.existsSync(p)) {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t) return t;
    }
  } catch { /* no token */ }
  return '';
}

function createUpdaterState() {
  return {
    available: null,   // null | false | true
    downloading: false,
    downloaded: false,
    info: null,
    error: null,
    feedConfigured: feedConfigured(),
  };
}

/**
 * @param {{send:(evt:string,payload:any)=>void, userDataDir:string}} opts
 * @returns state object (also emitted as updateStatus) — inert when no feed.
 */
function initUpdater({ send, userDataDir }) {
  const state = createUpdaterState();
  const push = () => send('updateStatus', { ...state, info: state.info ? { ...state.info } : null });

  if (!state.feedConfigured) return state;

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    state.error = `electron-updater unavailable: ${err.message}`;
    return state;
  }

  const token = resolveToken(userDataDir);
  if (token) {
    // set before any request fires; electron-updater reads it for the GitHub API
    process.env.GH_TOKEN = token;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;
  if (autoUpdater.logger?.transports?.file) autoUpdater.logger.transports.file.level = 'warn';

  autoUpdater.on('checking-for-update', () => { state.available = null; state.error = null; push(); });
  autoUpdater.on('update-available', (info) => {
    state.available = true;
    state.info = { version: info?.version, releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes.slice(0, 500) : null };
    push();
  });
  autoUpdater.on('update-not-available', () => { state.available = false; state.info = null; push(); });
  autoUpdater.on('download-progress', (p) => {
    state.downloading = true;
    state.info = { ...(state.info || {}), pct: p?.percent ?? 0, mbps: p?.bytesPerSecond ? p.bytesPerSecond / 1e6 : 0 };
    push();
  });
  autoUpdater.on('update-downloaded', (info) => {
    state.downloading = false;
    state.downloaded = true;
    state.info = { ...(state.info || {}), version: info?.version };
    push();
  });
  autoUpdater.on('error', (err) => {
    state.downloading = false;
    state.error = String(err?.message || err);
    push();
  });

  // First check shortly after launch: offline-safe (error state is silent in the renderer).
  setTimeout(() => { checkForUpdates().catch(() => {}); }, 30 * 1000);

  async function checkForUpdates() {
    if (!state.feedConfigured) return { ok: false, error: 'no update feed (not an installed build)' };
    try { await autoUpdater.checkForUpdates(); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err?.message || err) }; }
  }

  state.check = checkForUpdates;
  state.download = async () => {
    if (!state.available) return { ok: false, error: 'no update available' };
    try { await autoUpdater.downloadUpdate(); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err?.message || err) }; }
  };
  state.install = () => {
    if (!state.downloaded) return { ok: false, error: 'no downloaded update' };
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  };
  return state;
}

/** Test hook: run the state machine against a stubbed autoUpdater. */
function _withStubbedUpdater(fn) {
  const orig = require.cache[require.resolve('electron-updater')];
  return fn(() => { if (orig) require.cache[require.resolve('electron-updater')] = orig; });
}

module.exports = { initUpdater, feedConfigured, resolveToken, createUpdaterState, _withStubbedUpdater };
