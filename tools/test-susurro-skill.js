'use strict';
/**
 * Hermes skill helper test — Windows PowerShell against a fake MCP endpoint.
 *   node tools/test-susurro-skill.js
 *
 * Verifies the helper's JSON-RPC envelope, bearer header, protocol header, subcommands,
 * token redaction, and 401 handling without launching the real app.
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repo = path.join(__dirname, '..');
const script = path.join(repo, 'integrations', 'hermes', 'susurro-live', 'scripts', 'susurro.ps1');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-skill-test-'));
const discoveryPath = path.join(root, 'mcp.json');
const token = 'a'.repeat(64);
const requests = [];
let rejectAuth = false;

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let msg = null;
    try { msg = JSON.parse(raw); } catch { /* notification/empty */ }
    requests.push({ msg, headers: req.headers });
    if (rejectAuth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }));
      return;
    }
    if (msg && msg.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    const id = msg && msg.id != null ? msg.id : 1;
    if (msg && msg.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0', id,
        result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'susurroLive', version: 'test' } },
      }));
      return;
    }
    if (msg && msg.method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0', id,
        result: { tools: [{ name: 'app_status', description: 'Read app status' }] },
      }));
      return;
    }
    if (msg && msg.method === 'tools/call') {
      const name = msg.params?.name;
      let result;
      if (name === 'app_status') {
        result = {
          ok: true, appVersion: 'test', rendererReady: true,
          mcp: { url: `http://127.0.0.1:${server.address().port}/mcp`, running: true, enabled: true },
          sessionsRoot: 'C:\\tmp\\sessions', session: null,
          recording: { active: false, paused: false, durationSec: 0, sources: [] },
          transcription: { remaining: 0, running: 0, complete: false },
        };
      } else if (name === 'recording_start') {
        result = {
          ok: true, name: 'SkillTest', sessionFolder: 'C:\\tmp\\sessions\\SkillTest',
          profile: 'voice', sources: [{ kind: 'mic', label: 'Default microphone' }],
          sampleRate: 48000, chunkSec: 1,
        };
      } else if (name === 'transcript_get') {
        result = { text: 'hello from susurro', wordCount: 3, complete: true };
      } else if (name === 'session_list') {
        result = { sessions: [] };
      } else {
        result = { ok: true, tool: name, args: msg.params?.arguments || {} };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
  });
});

function run(args) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args,
    ], {
      cwd: repo,
      env: { ...process.env, SUSURRO_MCP_DISCOVERY: discoveryPath },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve({ status: null, stdout, stderr: `${stderr}\nhelper timed out` });
    }, 30000);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
  });
}

(async () => {
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    fs.writeFileSync(discoveryPath, JSON.stringify({
      schema: 1, server: 'susurroLive', version: 'test',
      url: `http://127.0.0.1:${port}/mcp`, port, token, enabled: true,
      tools: ['app_status'], updatedAt: new Date().toISOString(),
    }));

    let r = await run(['status', '-Json']);
    assert.equal(r.status, 0, r.stderr);
    const status = JSON.parse(r.stdout);
    assert.equal(status.appVersion, 'test');
    assert.ok(!r.stdout.includes(token), 'token leaked into status output');
    assert.ok(!r.stderr.includes(token), 'token leaked into stderr');

    const init = requests.find((x) => x.msg?.method === 'initialize');
    assert.ok(init, 'initialize not sent');
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    assert.equal(init.headers['mcp-protocol-version'], '2025-11-25');
    assert.ok(requests.some((x) => x.msg?.method === 'notifications/initialized'));

    r = await run(['start', '-Profile', 'voice', '-Parent', 'C:\\tmp\\sessions', '-Name', 'SkillTest', '-Json']);
    assert.equal(r.status, 0, r.stderr);
    const started = JSON.parse(r.stdout);
    assert.equal(started.name, 'SkillTest');
    const startReq = requests.find((x) => x.msg?.params?.name === 'recording_start');
    assert.equal(startReq.msg.params.arguments.profile, 'voice');
    assert.equal(startReq.msg.params.arguments.parentDir, 'C:\\tmp\\sessions');
    assert.equal(startReq.msg.params.arguments.name, 'SkillTest');

    r = await run(['transcript', '-Format', 'text']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'hello from susurro');

    r = await run(['tools', '-Json']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('app_status'));

    r = await run(['raw', '-Tool', 'session_list', '-ArgsJson', '{"parentDir":"C:\\\\tmp\\\\sessions"}']);
    assert.equal(r.status, 0, r.stderr);

    rejectAuth = true;
    r = await run(['status', '-Json']);
    assert.notEqual(r.status, 0);
    assert.ok(/401|token|unauthorized/i.test(r.stderr), `expected 401 guidance, got: ${r.stderr}`);
    assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token), 'token leaked on 401');

    console.log(`SKILL-TEST-RESULT: ${JSON.stringify({ ok: true, requests: requests.length, port })}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
