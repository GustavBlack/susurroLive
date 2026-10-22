'use strict';
/**
 * End-to-end MCP recording test — real Electron main + renderer + recorder + pipeline,
 * with synthetic microphone audio and deterministic ASR.
 *   node tools/test-mcp-e2e.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], {
    cwd: repo, env, stdio: 'inherit', windowsHide: true,
  });
  const timeout = setTimeout(() => { console.error('MCP E2E timed out'); child.kill(); }, 95000);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-mcp-e2e-'));
  const userData = path.join(root, 'user-data');
  const sessions = path.join(root, 'sessions');
  for (const directory of [userData, sessions]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    lastSessionParent: sessions,
    chunkSec: 1,
    showGpuBanner: false,
    lastSources: [],
    mcpEnabled: true,
    mcpPort: 0,
  }));
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  const watchdog = setTimeout(() => { console.error('MCP E2E watchdog expired'); app.exit(1); }, 90000);

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

  // Wait for the embedded server to bind and publish discovery.
  const discoveryPath = path.join(userData, 'mcp.json');
  let doc = null;
  for (let i = 0; i < 120; i++) {
    try {
      doc = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
      if (doc.url && doc.enabled && doc.token) break;
    } catch { /* not written yet */ }
    await delay(100);
  }
  assert.ok(doc && doc.url, 'MCP discovery was not written');
  const endpoint = new URL(doc.url);
  const token = doc.token;

  function rpc(method, params) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: endpoint.hostname,
        port: Number(endpoint.port),
        path: endpoint.pathname,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'MCP-Protocol-Version': '2025-11-25',
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (err) { reject(new Error(`bad response: ${data}`)); }
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  async function tool(name, args = {}) {
    const res = await rpc('tools/call', { name, arguments: args });
    assert.ok(res.result, `${name} returned no result: ${JSON.stringify(res)}`);
    if (res.result.isError) throw new Error(`${name}: ${res.result.content?.[0]?.text || 'tool error'}`);
    return JSON.parse(res.result.content[0].text);
  }

  assert.equal((await rpc('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' },
  })).result.protocolVersion, '2025-11-25');

  // The renderer bridge exposes status/config without the token, and the Settings block renders.
  const bridgeStatus = await js('window.susurro.mcp.status()');
  assert.equal(bridgeStatus.running, true);
  assert.equal(bridgeStatus.enabled, true);
  assert.equal(Object.prototype.hasOwnProperty.call(bridgeStatus, 'token'), false);
  const copied = await js('window.susurro.mcp.copyConfig()');
  assert.equal(copied.ok, true);
  await js('document.getElementById("btnSettings").click()');
  for (let i = 0; i < 40; i++) {
    if ((await js('document.getElementById("mcpStatus").textContent')).includes('Listening')) break;
    await delay(100);
  }
  assert.match(await js('document.getElementById("mcpStatus").textContent'), /Listening/);
  assert.match(await js('document.getElementById("mcpEndpoint").textContent'), /127\.0\.0\.1:/);
  await js('document.getElementById("btnCloseSettings").click()');

  // Inject synthetic capture after the real app signals readiness.
  await js(`(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    window.__testAudio = [];
    window.__testGetUserMediaCalls = 0;
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
  })()`);

  const started = await tool('recording_start', {
    profile: 'voice', parentDir: sessions, name: 'MCP E2E', chunkSec: 1,
  });
  assert.equal(started.ok, true);
  assert.equal(started.sessionFolder.startsWith(sessions + path.sep), true);
  assert.equal(started.sources.length, 1);
  assert.equal(started.sources[0].kind, 'mic');

  let status = null;
  for (let i = 0; i < 80; i++) {
    status = await tool('recording_status');
    if (status.recording.durationSec >= 1.3) break;
    await delay(100);
  }
  assert.ok(status.recording.durationSec >= 1.3, 'recording did not accumulate audio');
  assert.equal(await js('document.getElementById("btnRecord").classList.contains("recording")'), true);

  await tool('recording_pause');
  assert.equal((await tool('recording_status')).recording.paused, true);
  await tool('recording_resume');

  for (let i = 0; i < 80; i++) {
    status = await tool('recording_status');
    if (status.recording.durationSec >= 2.3) break;
    await delay(100);
  }

  const stopped = await tool('recording_stop', { waitForTranscription: true, timeoutMs: 20000 });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.transcription.complete, true);
  assert.ok(stopped.chunks >= 1);
  assert.ok(fs.existsSync(path.join(stopped.sessionFolder, 'audio', 'full.wav')), 'full.wav missing');

  const transcript = await tool('transcript_get', { format: 'json', includeWords: true });
  assert.equal(transcript.complete, true);
  assert.ok(transcript.wordCount >= 1);
  assert.match(transcript.text, /Pass\d/);
  assert.ok(Array.isArray(transcript.words) && transcript.words.length >= 1);
  assert.ok(asrCalls >= 1, 'ASR stub was not called');

  const listed = await tool('session_list', { parentDir: sessions });
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].folder, stopped.sessionFolder);

  const exported = await tool('export_run', { kind: 'txt' });
  assert.ok(fs.existsSync(exported.path), 'txt export missing');

  const opened = await tool('session_open', { folder: stopped.sessionFolder });
  assert.equal(opened.ok, true);
  for (let i = 0; i < 40; i++) {
    if (await js('document.getElementById("folderPath").textContent.includes("MCP-E2E")')) break;
    await delay(100);
  }
  assert.equal(await js('document.getElementById("folderPath").textContent.includes("MCP-E2E")'), true);

  // Settings toggle stops and restarts the listener through the real settings IPC.
  await js('document.getElementById("btnSettings").click()');
  await js(`(() => {
    const el = document.getElementById('setMcpEnabled');
    el.checked = false;
    el.dispatchEvent(new Event('change'));
  })()`);
  for (let i = 0; i < 50; i++) {
    if ((await js('window.susurro.mcp.status()')).running === false) break;
    await delay(100);
  }
  assert.equal((await js('window.susurro.mcp.status()')).running, false);
  assert.equal((await js('window.susurro.mcp.status()')).enabled, false);
  await js(`(() => {
    const el = document.getElementById('setMcpEnabled');
    el.checked = true;
    el.dispatchEvent(new Event('change'));
  })()`);
  for (let i = 0; i < 50; i++) {
    if ((await js('window.susurro.mcp.status()')).running === true) break;
    await delay(100);
  }
  assert.equal((await js('window.susurro.mcp.status()')).running, true);
  await js('document.getElementById("btnCloseSettings").click()');

  assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join('; ')}`);
  assert.equal(await js('window.__err || null'), null);
  await js('Promise.all(window.__testAudio.map(a => a.context.close()))');
  console.log(`MCP-E2E-RESULT: ${JSON.stringify({
    ok: true, sessionFolder: stopped.sessionFolder, chunks: stopped.chunks,
    words: transcript.wordCount, asrCalls, root,
  })}`);
  clearTimeout(watchdog);
  app.exit(0);
}
