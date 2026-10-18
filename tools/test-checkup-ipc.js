'use strict';
/**
 * AI checkup IPC test: the REAL main process + preload bridge in an invisible window, with a
 * local stub OpenAI-compatible endpoint (node:http) — no native binaries, no real LLM.
 *   node tools/test-checkup-ipc.js
 *
 * Asserts the plan's B8 contract: non-destructive persistence, projected payload vs toggle,
 * discard, the single-run guard, retranscription drift, and the clean-slate re-run.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repo = path.join(__dirname, '..');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const exe = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(exe, [__filename], { cwd: repo, env, stdio: 'inherit', windowsHide: true });
  const timeout = setTimeout(() => { console.error('Checkup IPC test timed out'); child.kill(); }, 90000);
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

  // ---- stub OpenAI-compatible endpoint (runs in THIS main process) ----
  let chatResponse = { edits: [] };   // what /chat/completions answers next
  let chatGate = null;                // when set, responses wait for release
  let chatRequests = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      if (req.url.endsWith('/chat/completions')) {
        chatRequests++;
        if (chatGate) await chatGate.promise;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ edits: chatResponse.edits }) } }] }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-checkup-ipc-'));
  const userData = path.join(root, 'user-data');
  const sessions = path.join(root, 'sessions');
  for (const directory of [userData, sessions]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    lastSessionParent: sessions, chunkSec: 60, showGpuBanner: false, lastSources: [],
    llmCheckup: true, llmEndpoint: base, llmApiKey: '', llmModel: 'stub-model', llmContextTokens: 8192,
  }));
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  const watchdog = setTimeout(() => { console.error('Checkup IPC watchdog expired'); app.exit(1); }, 85000);

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

  // ---- stub the whisper engine so no native binaries are needed ----
  const { Engine } = require('../src/main/whisper');
  Engine.prototype.transcribe = async function(_audioPath, options) {
    return { engine: 'test-synthetic', language: 'en', words: [{ t: 0.1, d: 0.4, w: `Word${options.chunkIndex}` }], text: 'w' };
  };

  const store = require('../src/main/session');
  // 2 finished chunks -> global words: 0 alpha, 1 bravo, 2 charlie. | 3 delta, 4 echo, 5 foxtrot.
  const makeSession = (name) => {
    const s = store.createSession({ parentDir: sessions, name, settings: {}, gpu: null, chunkSec: 30 });
    const mk = (i, offset, words) => ({
      index: i, offsetSec: offset, durationSec: 3, audioFile: `audio/chunk_000${i}.wav`, status: 'done',
      words: words.map(([t, d, w]) => ({ t, d, w })),
    });
    s.chunks = [
      mk(0, 0, [[0.2, 0.3, 'alpha'], [1.5, 0.3, 'bravo'], [2.4, 0.3, 'charlie.']]),
      mk(1, 30, [[0.2, 0.3, 'delta'], [1.5, 0.3, 'echo'], [2.4, 0.3, 'foxtrot.']]),
    ];
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

  await js(`(() => {
    window.__ev = [];
    for (const evt of ['llmCheckupProgress', 'llmCheckupDone', 'llmCheckupError']) {
      window.susurro.on(evt, (p) => window.__ev.push({ evt, ...p }));
    }
  })()`);

  const storedWordsOf = (file) => file.transcript.words.map((w) => w.w);
  const currentWords = async () => (await js('window.susurro.session.current()')).transcript.words.map((w) => w.w);

  console.log('\\n=== (a) run: stored words unchanged, checkup block written ===');
  chatResponse = { edits: [{ i: 1, w: 'brother' }, { i: 4, w: 'eko' }] };
  const folder = makeSession('Checkup');
  await js(`window.susurro.session.open(${JSON.stringify(folder)})`);
  await js('window.susurro.session.rename("Checkup")'); // force a persist so the baseline is the rebuilt transcript, not the fixture
  const wordsBefore = storedWordsOf(readFile(folder));
  const run = await js('window.susurro.llm.checkup.run()');
  check('run resolves ok', run.ok === true && run.applied === 2, JSON.stringify(run));
  await until('llmCheckupDone event', async () => (await js('window.__ev')).some((e) => e.evt === 'llmCheckupDone' && e.applied === 2));
  const fileA = readFile(folder);
  check('stored words on disk UNCHANGED', JSON.stringify(storedWordsOf(fileA)) === JSON.stringify(wordsBefore),
    JSON.stringify(storedWordsOf(fileA)));
  check('checkup block written with edits', fileA.checkup?.applied === 2 && fileA.checkup.active === true
    && fileA.checkup.edits.length === 2 && fileA.checkup.model === 'stub-model');
  check('chunkHashes cover both chunks', Object.keys(fileA.checkup.chunkHashes).sort().join(',') === '0,1');
  check('payload shows corrected words while active', JSON.stringify(await currentWords())
    === JSON.stringify(['alpha', 'brother', 'charlie.', 'delta', 'eko', 'foxtrot.']));

  console.log('\\n=== (b) toggle corrected/original ===');
  const tog = await js('window.susurro.llm.checkup.toggle(false)');
  check('toggle resolves active:false', tog.ok === true && tog.active === false);
  check('payload shows ORIGINAL words after toggle off', JSON.stringify(await currentWords()) === JSON.stringify(wordsBefore));
  check('toggle persisted active:false', readFile(folder).checkup.active === false);
  await js('window.susurro.llm.checkup.toggle(true)');
  check('payload corrected again after toggle on', (await currentWords())[1] === 'brother');

  console.log('\\n=== (d) single-run guard ===');
  let release;
  chatGate = { promise: new Promise((r) => { release = r; }) };
  chatResponse = { edits: [{ i: 0, w: 'ALPHA' }] };
  await js('(window.__run1 = window.susurro.llm.checkup.run(), true)');
  await until('first run reached the stub', () => chatRequests >= 2);
  const second = await js('window.susurro.llm.checkup.run()');
  check('second concurrent run rejected', second.ok === false && /already active/.test(second.error), second.error);
  release();
  const first = await js('window.__run1');
  check('first run completes', first.ok === true, JSON.stringify(first));

  console.log('\\n=== (f) re-run replaces the whole block (clean slate) ===');
  // the (d) run just rewrote the block with 1 edit; re-run with 2 different edits
  chatResponse = { edits: [{ i: 2, w: 'charlie!' }, { i: 5, w: 'fox-trot.' }] };
  const rerun = await js('window.susurro.llm.checkup.run()');
  check('re-run ok', rerun.ok === true && rerun.applied === 2, JSON.stringify(rerun));
  const fileF = readFile(folder);
  check('block fully replaced (old edits gone)', fileF.checkup.edits.length === 2
    && fileF.checkup.edits.every((e) => [2, 5].includes(e.i)), JSON.stringify(fileF.checkup.edits));
  check('payload reflects the new edits', JSON.stringify(await currentWords())
    === JSON.stringify(['alpha', 'bravo', 'charlie!', 'delta', 'echo', 'fox-trot.']));

  console.log('\\n=== (e) drift: chunk re-transcribed after the checkup ===');
  // mutate chunk 0's stored words on disk (simulating a re-transcription), then re-open
  const driftFile = readFile(folder);
  driftFile.chunks[0].words[1].w = 'bravo-mutated';
  store.writeSession(folder, driftFile);
  await js(`window.susurro.session.open(${JSON.stringify(folder)})`);
  const cur = await js('window.susurro.session.current()');
  const w = cur.transcript.words.map((x) => x.w);
  check('drifted chunk reverted to ORIGINAL words', w[1] === 'bravo-mutated' && w[2] === 'charlie.', JSON.stringify(w));
  check('drifted chunk reported in driftedChunkIds', JSON.stringify(cur.transcript.driftedChunkIds) === JSON.stringify(['0']),
    JSON.stringify(cur.transcript.driftedChunkIds));
  check('other chunks stay checked-up', w[5] === 'fox-trot.', JSON.stringify(w));
  // export mirrors the UI projection exactly
  const exp = await js('window.susurro.exportRun("json")');
  check('export ok', exp.ok === true, exp.error);
  const exported = JSON.parse(fs.readFileSync(exp.path, 'utf8'));
  check('export words == UI projection words',
    JSON.stringify(exported.transcript.words) === JSON.stringify(cur.transcript.words),
    JSON.stringify(exported.transcript.words.map((x) => x.w)));
  const expTxt = await js('window.susurro.exportRun("txt")');
  const txt = fs.readFileSync(expTxt.path, 'utf8');
  check('txt export mirrors the same mixed view', txt.includes('bravo-mutated') && txt.includes('fox-trot.'));

  console.log('\\n=== (c) discard ===');
  const dis = await js('window.susurro.llm.checkup.discard()');
  check('discard resolves ok', dis.ok === true);
  check('checkup block removed from session.json', !readFile(folder).checkup);
  check('payload back to pure original', JSON.stringify(await currentWords())
    === JSON.stringify(['alpha', 'bravo-mutated', 'charlie.', 'delta', 'echo', 'foxtrot.']));
  const dis2 = await js('window.susurro.llm.checkup.toggle(false)');
  check('toggle after discard refused', dis2.ok === false && /no checkup block/.test(dis2.error));

  clearTimeout(watchdog);
  server.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('\\nCHECKUP IPC: PASS');
  app.exit(0);
}
