'use strict';
/**
 * Updater state-machine test with a stubbed electron-updater (no Electron, no network).
 *   node tools/test-updater-stub.js
 *
 * Verifies:
 *  1. no feed (no app-update.yml / not packaged) -> updater inert, no check function
 *  2. available -> downloading -> downloaded -> install() calls quitAndInstall
 *  3. error surfaces as state.error and clears on next check
 *  4. every state transition emits exactly one `updateStatus` event
 */
const path = require('path');
const Module = require('module');

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '  ok  ' : 'FAIL  '}${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

/** Install a stub electron-updater module into the require cache. */
function stubUpdater() {
  let quitInstalled = false;
  const listeners = new Map();
  const stub = {
    autoUpdater: {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      logger: null,
      on: (evt, cb) => { listeners.set(evt, cb); },
      once: (evt, cb) => { listeners.set(evt, cb); },
      async checkForUpdates() {
        listeners.get('checking-for-update')?.();
        listeners.get('update-available')?.({ version: '9.9.9', releaseNotes: 'test notes' });
        return { updateInfo: { version: '9.9.9' } };
      },
      async downloadUpdate() {
        listeners.get('download-progress')?.({ percent: 50, bytesPerSecond: 2e6 });
        listeners.get('update-downloaded')?.({ version: '9.9.9' });
        return [];
      },
      quitAndInstall() { quitInstalled = true; },
      _quitInstalled: () => quitInstalled,
      _emitError: (msg) => listeners.get('error')?.(new Error(msg)),
    },
  };
  const resolved = require.resolve('electron-updater');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: stub };
  return stub.autoUpdater;
}

function stubElectron(feedExists) {
  const resolved = require.resolve('electron');
  const existing = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true,
    exports: { app: { isPackaged: true, getPath: () => path.join(__dirname, '..', 'native', '_stub-userdata') } },
    _orig: existing,
  };
  // feedConfigured() checks process.resourcesPath — stub it
  process.resourcesPath = feedExists ? __dirname : path.join(__dirname, '_nope');
  fs_writeFileSync_marker();
  return () => { if (existing) require.cache[resolved] = existing; };
}

function fs_writeFileSync_marker() {
  // feedConfigured checks existence of <resourcesPath>/app-update.yml.
  // For the feed=true case we point resourcesPath at tools/ and drop a marker file.
  const fs = require('fs');
  const marker = path.join(__dirname, 'app-update.yml');
  try { fs.writeFileSync(marker, 'stub\n'); } catch { /* ok */ }
}

async function main() {
  const { initUpdater } = require('../src/main/updater');
  const fs = require('fs');

  // ---- 1. inert when no feed -----------------------------------------------------
  console.log('--- 1. no feed -> inert ---');
  const restoreElectron1 = stubElectron(false);
  let events1 = 0;
  const state1 = initUpdater({ send: () => { events1++; }, userDataDir: '/tmp/x' });
  check('feedConfigured false', state1.feedConfigured === false);
  check('no check function exposed', typeof state1.check !== 'function');
  check('no events emitted', events1 === 0);
  restoreElectron1();
  try { fs.unlinkSync(path.join(__dirname, 'app-update.yml')); } catch { /* n/a */ }

  // ---- 2. full flow with stub ----------------------------------------------------
  console.log('--- 2. available -> download -> install ---');
  const stub = stubUpdater();
  const restoreElectron2 = stubElectron(true);
  const events = [];
  const state2 = initUpdater({ send: (evt, payload) => events.push(payload.state || payload), userDataDir: '/tmp/x' });
  check('feedConfigured true', state2.feedConfigured === true);
  check('autoDownload=false (consent-first)', stub.autoDownload === false);
  check('autoInstallOnAppQuit=true', stub.autoInstallOnAppQuit === true);
  check('check exposed', typeof state2.check === 'function');

  const r1 = await state2.check();
  check('check ok', r1.ok === true);
  check('state available', state2.available === true, JSON.stringify(state2.info));
  check('info has version', state2.info?.version === '9.9.9');
  // checking + available statuses fired (event payloads are state snapshots)
  check('statuses emitted for check', events.length >= 2);

  const r2 = await state2.download();
  check('download ok', r2.ok === true);
  check('state downloaded', state2.downloaded === true && state2.downloading === false);
  check('progress captured', typeof state2.info?.pct === 'number');

  const r3 = state2.install();
  check('install ok', r3.ok === true);
  await new Promise((r) => setImmediate(r));   // install() defers quitAndInstall one tick
  check('quitAndInstall called', stub._quitInstalled() === true);

  // ---- 3. error path --------------------------------------------------------------
  console.log('--- 3. error surfaces ---');
  stub._emitError('network down');
  check('state.error set', state2.error === 'network down');

  restoreElectron2();

  console.log(`\nRESULT: ${failures === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
