'use strict';
/**
 * Embedded, stateless MCP server (Streamable HTTP, JSON responses).
 *
 * Security model:
 *  - bind 127.0.0.1 only;
 *  - Host allowlist (DNS-rebinding guard);
 *  - reject any Origin header (no browser clients);
 *  - bearer token from userData/mcp.json, compared in constant time;
 *  - 1 MiB request body cap; no token or tool args in logs.
 */
const http = require('http');
const crypto = require('crypto');

const MAX_BODY = 1024 * 1024;
const SUPPORTED_VERSIONS = new Set(['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28']);
const LATEST_VERSION = '2025-11-25';

const INSTRUCTIONS = [
  'susurroLive is a local recording studio. Typical flow:',
  '1. app_status — check rendererReady and the current session.',
  '2. recording_start — profile=meeting adds the default microphone and system loopback;',
  '   voice adds only the microphone; system adds only loopback; custom uses the sources array.',
  '   Pass parentDir for the sessions folder and name for the session.',
  '3. recording_status while capturing.',
  '4. recording_stop {waitForTranscription:true} to finalize and drain the chunk pipeline.',
  '5. transcript_get {format:"text"} for prose, or format:"json" for timecoded words.',
  '6. export_run {kind:"txt"|"json"|"audio"} for files.',
  'Sessions are folders containing session.json and AGENTS.md; they can also be read directly.',
  'Do not start a recording unless the user asked for one.',
].join('\n');

function tokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function createMcpServer({ version, tools, discovery, logger = console }) {
  let server = null;
  let port = null;
  let url = null;
  let error = null;
  let mutationQueue = Promise.resolve();

  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  /** Mutating tools are serialized; read-only tools run concurrently. */
  function runMutation(fn) {
    const next = mutationQueue.then(fn, fn);
    mutationQueue = next.catch(() => {});
    return next;
  }

  function info() {
    return {
      enabled: !!server && server.listening,
      running: !!server && server.listening,
      url,
      port,
      error,
      toolCount: tools.length,
      tools: tools.map((t) => t.name),
      discoveryPath: discovery.file,
    };
  }

  function sendJson(res, status, body, headers = {}) {
    const data = body == null ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(data);
  }

  function rpcError(id, code, message, data) {
    const err = { code, message };
    if (data !== undefined) err.data = data;
    return { jsonrpc: '2.0', id: id === undefined ? null : id, error: err };
  }

  function checkHost(req) {
    const host = String(req.headers.host || '').toLowerCase();
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
  }

  function checkOrigin(req) {
    return !req.headers.origin;
  }

  function checkAuth(req) {
    const expected = discovery.readToken();
    const header = String(req.headers.authorization || '');
    if (!expected || !header.startsWith('Bearer ')) return false;
    return tokenEqual(header.slice('Bearer '.length).trim(), expected);
  }

  function readBody(req, res) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let rejected = false;
      req.on('data', (chunk) => {
        if (rejected) return;
        size += chunk.length;
        if (size > MAX_BODY) {
          rejected = true;
          sendJson(res, 413, rpcError(null, -32600, `request body exceeds ${MAX_BODY} bytes`));
          req.resume();   // drain; do not destroy, or the client can lose the 413 response
          reject(new Error('body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', (err) => { if (!rejected) reject(err); });
    });
  }

  async function initialize(params) {
    const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : LATEST_VERSION;
    const protocolVersion = SUPPORTED_VERSIONS.has(requested) && requested !== '2026-07-28'
      ? requested
      : LATEST_VERSION;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'susurroLive', version },
      instructions: INSTRUCTIONS,
    };
  }

  async function callTool(params) {
    if (!params || typeof params !== 'object') throw Object.assign(new Error('missing params'), { code: -32602 });
    const name = params.name;
    const args = params.arguments == null ? {} : params.arguments;
    if (typeof name !== 'string' || !name) throw Object.assign(new Error('tools/call requires a tool name'), { code: -32602 });
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw Object.assign(new Error('arguments must be an object'), { code: -32602 });
    const tool = byName.get(name);
    if (!tool) throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 });

    try {
      const readOnly = tool.annotations?.readOnlyHint === true;
      const result = readOnly ? await tool.handler(args) : await runMutation(() => tool.handler(args));
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: 'text', text }], isError: false };
    } catch (err) {
      if (err && err.isToolError) {
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
      logger.error(`[mcp] tool ${name} failed:`, err && err.message ? err.message : err);
      return {
        content: [{ type: 'text', text: `tool ${name} failed: ${err && err.message ? err.message : err}` }],
        isError: true,
      };
    }
  }

  async function handleRpc(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return { body: rpcError(null, -32600, 'invalid request') };
    }
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return { body: rpcError(msg.id, -32600, 'invalid JSON-RPC request') };
    }
    const isNotification = !Object.prototype.hasOwnProperty.call(msg, 'id');
    if (isNotification) {
      // initialized / cancelled / unknown notifications are accepted and ignored.
      return { notification: true };
    }
    const id = msg.id;
    const params = msg.params || {};
    try {
      switch (msg.method) {
        case 'initialize':
          return { body: { jsonrpc: '2.0', id, result: await initialize(params) } };
        case 'ping':
          return { body: { jsonrpc: '2.0', id, result: {} } };
        case 'tools/list':
          return {
            body: {
              jsonrpc: '2.0',
              id,
              result: {
                tools: tools.map(({ name, description, inputSchema, annotations }) => ({
                  name, description, inputSchema, ...(annotations ? { annotations } : {}),
                })),
              },
            },
          };
        case 'tools/call':
          return { body: { jsonrpc: '2.0', id, result: await callTool(params) } };
        default:
          return { body: rpcError(id, -32601, `method not found: ${msg.method}`) };
      }
    } catch (err) {
      if (err && err.code === -32602) return { body: rpcError(id, -32602, err.message) };
      logger.error('[mcp] request failed:', err && err.message ? err.message : err);
      return { body: rpcError(id, -32603, 'internal error') };
    }
  }

  async function handle(req, res) {
    try {
      if (!checkHost(req)) {
        return sendJson(res, 403, rpcError(null, -32600, 'invalid Host header'));
      }
      if (!checkOrigin(req)) {
        return sendJson(res, 403, rpcError(null, -32600, 'browser Origin is not allowed'));
      }

      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, { ok: true, server: 'susurroLive', version, tools: tools.length });
      }

      if (req.method === 'GET' && req.url === '/mcp') {
        res.writeHead(405, { Allow: 'POST' });
        return res.end();
      }
      if (req.method === 'DELETE' && req.url === '/mcp') {
        res.writeHead(405, { Allow: 'POST' });
        return res.end();
      }
      if (req.method !== 'POST' || req.url !== '/mcp') {
        return sendJson(res, 404, { ok: false, error: 'not found' });
      }

      const versionHeader = req.headers['mcp-protocol-version'];
      if (versionHeader && !SUPPORTED_VERSIONS.has(String(versionHeader))) {
        return sendJson(res, 400, rpcError(null, -32600, `unsupported MCP-Protocol-Version: ${versionHeader}`));
      }

      if (!checkAuth(req)) {
        return sendJson(res, 401, rpcError(null, -32001, 'missing or invalid bearer token'), {
          'WWW-Authenticate': 'Bearer realm="susurroLive"',
        });
      }

      const raw = await readBody(req, res);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return sendJson(res, 200, rpcError(null, -32700, 'parse error'));
      }

      const out = await handleRpc(msg);
      if (out.notification) {
        res.writeHead(202);
        return res.end();
      }
      return sendJson(res, 200, out.body);
    } catch (err) {
      logger.error('[mcp] http handler failed:', err && err.message ? err.message : err);
      if (!res.headersSent) sendJson(res, 500, rpcError(null, -32603, 'internal error'));
      else res.end();
    }
  }

  async function start(preferredPort = 8790) {
    await stop();
    error = null;
    const desired = Number.isInteger(Number(preferredPort)) && Number(preferredPort) >= 0
      ? Number(preferredPort)
      : 8790;
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => { void handle(req, res); });
      srv.requestTimeout = 130000;
      srv.headersTimeout = 20000;
      srv.keepAliveTimeout = 5000;
      srv.once('error', (err) => {
        error = String(err.message || err);
        server = null;
        port = null;
        url = null;
        try { discovery.write({ enabled: false, tools: [] }); } catch { /* non-fatal */ }
        logger.error(`[mcp] server error: ${error}`);
        resolve({ ok: false, ...info() });
      });
      srv.listen(desired, '127.0.0.1', () => {
        server = srv;
        port = srv.address().port;
        url = `http://127.0.0.1:${port}/mcp`;
        discovery.write({ url, port, tools: tools.map((t) => t.name), enabled: true });
        logger.log(`[mcp] listening on ${url} (${tools.length} tools)`);
        resolve({ ok: true, ...info() });
      });
    });
  }

  async function stop() {
    if (!server) {
      try { discovery.write({ enabled: false, tools: [] }); } catch { /* non-fatal */ }
      return;
    }
    const srv = server;
    server = null;
    await new Promise((resolve) => {
      srv.close(() => resolve());
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    });
    port = null;
    url = null;
    try { discovery.write({ enabled: false, tools: [] }); } catch { /* non-fatal */ }
  }

  function rotateToken() {
    discovery.rotate();
    return info();
  }

  function hermesConfig() {
    return discovery.hermesConfig(url);
  }

  return { start, stop, info, rotateToken, hermesConfig, tools };
}

module.exports = { createMcpServer, INSTRUCTIONS, MAX_BODY, SUPPORTED_VERSIONS };
