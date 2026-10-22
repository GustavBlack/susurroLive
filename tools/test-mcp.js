'use strict';
/**
 * MCP protocol/auth test — no Electron, no native binaries.
 *   node tools/test-mcp.js
 *
 * Exercises the real HTTP server + tool registry with a fake controller: auth, Host/Origin
 * guards, initialize, tools/list, tools/call, notifications, limits, and token rotation.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createDiscovery } = require('../src/main/mcp/discovery');
const { createMcpServer } = require('../src/main/mcp/server');
const { createTools } = require('../src/main/mcp/tools');
const { ToolError } = require('../src/main/mcp/errors');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-mcp-test-'));
const userData = path.join(root, 'user-data');
fs.mkdirSync(userData, { recursive: true });

const calls = [];
let mutationDepth = 0;
let mutationMax = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fake = {
  status: () => ({ ok: true, appVersion: 'test', rendererReady: true, session: null }),
  sources: async () => ({ ok: true, microphones: [], loopbacks: [], current: [], profiles: {} }),
  listSessions: () => ({ ok: true, parentDir: root, sessions: [] }),
  createSession: () => ({ ok: true, session: { folder: root, name: 'test' } }),
  openSession: () => ({ ok: true, session: { folder: root, name: 'test' } }),
  startRecording: async () => { throw new ToolError('microphone permission denied'); },
  pauseRecording: async () => {
    mutationDepth++;
    mutationMax = Math.max(mutationMax, mutationDepth);
    await sleep(25);
    mutationDepth--;
    return { ok: true };
  },
  resumeRecording: async () => ({ ok: true }),
  stopRecording: async () => ({ ok: true, durationSec: 1 }),
  waitForTranscription: async () => ({ complete: true }),
  retryTranscription: () => ({ ok: true }),
  transcriptGet: () => ({ ok: true, text: 'hello world', wordCount: 2 }),
  exportSession: () => ({ ok: true, path: path.join(root, 'full.txt'), bytes: 10 }),
  importMedia: async () => ({ ok: true }),
  diarize: async () => ({ ok: true }),
  diarizeStatus: () => ({ ok: true, available: false }),
  settingsSet: () => ({ ok: true, settings: {} }),
};

const discovery = createDiscovery({ userDataDir: userData, version: 'test' });
discovery.ensure();
const tools = createTools(fake);
const server = createMcpServer({ version: 'test', tools, discovery, logger: { log() {}, error() {} } });

function post(body, { token, host, origin, headers = {}, raw = false } = {}) {
  const payload = raw ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.info().port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(host ? { Host: host } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* raw */ }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function get(pathname, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.info().port, path: pathname, method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

let id = 1;
async function rpc(method, params, opts = {}) {
  const token = opts.token || discovery.readToken();
  return post({ jsonrpc: '2.0', id: id++, method, params }, { token, ...opts });
}
async function tool(name, args = {}, opts = {}) {
  return rpc('tools/call', { name, arguments: args }, opts);
}

(async () => {
  try {
    const started = await server.start(0);
    assert.equal(started.ok, true);
    assert.ok(server.info().port > 0);
    const token = discovery.readToken();
    assert.match(token, /^[0-9a-f]{64}$/);

    let r = await rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.result.protocolVersion, '2025-11-25');
    assert.equal(r.json.result.serverInfo.name, 'susurroLive');
    assert.ok(r.json.result.instructions.includes('recording_start'));

    r = await rpc('tools/list', {});
    const names = r.json.result.tools.map((t) => t.name);
    for (const name of ['app_status', 'recording_start', 'transcript_get', 'export_run']) {
      assert.ok(names.includes(name), `missing tool ${name}`);
    }
    const recStart = r.json.result.tools.find((t) => t.name === 'recording_start');
    assert.equal(recStart.inputSchema.properties.profile.enum.includes('meeting'), true);

    r = await tool('app_status');
    assert.equal(r.status, 200);
    assert.equal(r.json.result.isError, false);
    assert.ok(r.json.result.content[0].text.includes('"appVersion": "test"'));

    r = await tool('recording_start', { profile: 'voice' });
    assert.equal(r.json.result.isError, true);
    assert.match(r.json.result.content[0].text, /microphone permission denied/);

    // Mutating tools are serialized (no interleaved state transitions).
    await Promise.all([tool('recording_pause'), tool('recording_pause')]);
    assert.equal(mutationMax, 1, `mutating tools overlapped: ${mutationMax}`);

    r = await tool('app_status', { bogus: true });
    assert.equal(r.json.result.isError, true);
    assert.match(r.json.result.content[0].text, /unknown argument/);

    r = await tool('not_a_tool');
    assert.equal(r.status, 200);
    assert.equal(r.json.error.code, -32602);

    // notifications are accepted with 202 and no body.
    r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { token });
    assert.equal(r.status, 202);
    assert.equal(r.body, '');

    // auth / transport guards.
    r = await rpc('tools/list', {}, { token: null });
    assert.equal(r.status, 401);
    assert.match(r.headers['www-authenticate'], /Bearer/);
    r = await rpc('tools/list', {}, { host: 'evil.example' });
    assert.equal(r.status, 403);
    r = await rpc('tools/list', {}, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    r = await get('/mcp', token);
    assert.equal(r.status, 405);
    r = await get('/health', null);
    assert.equal(r.status, 200);

    // parse error and unsupported protocol header.
    r = await post('{not json', { token, raw: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.error.code, -32700);
    r = await rpc('tools/list', {}, { headers: { 'MCP-Protocol-Version': '1999-01-01' } });
    assert.equal(r.status, 400);

    // body cap.
    const huge = 'x'.repeat(1024 * 1024 + 20);
    r = await post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: { huge } }), { token });
    assert.equal(r.status, 413);

    // token rotation invalidates the old token immediately.
    const old = discovery.readToken();
    server.rotateToken();
    const fresh = discovery.readToken();
    assert.notEqual(old, fresh);
    r = await rpc('tools/list', {}, { token: old });
    assert.equal(r.status, 401);
    r = await rpc('tools/list', {}, { token: fresh });
    assert.equal(r.status, 200);

    console.log(`MCP-TEST-RESULT: ${JSON.stringify({ ok: true, tools: names.length, port: server.info().port })}`);
  } finally {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
