'use strict';
/**
 * MCP discovery + bearer token for local agents.
 *
 * The app writes one JSON file under its userData folder (normally
 * %APPDATA%\susurroLive\mcp.json). The token is the capability: it is never exposed to the
 * renderer, never logged, and is replaced only by an explicit rotate action.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 1;
const SERVER = 'susurroLive';

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createDiscovery({ userDataDir, version }) {
  const file = path.join(userDataDir, 'mcp.json');

  function read() {
    try {
      if (!fs.existsSync(file)) return null;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data || typeof data !== 'object') return null;
      if (typeof data.token !== 'string' || !/^[0-9a-f]{64}$/i.test(data.token)) return null;
      return data;
    } catch {
      return null;
    }
  }

  function write({ url = null, port = null, tools = [], enabled = true } = {}) {
    const prev = read();
    const token = prev?.token || newToken();
    const doc = {
      schema: SCHEMA,
      server: SERVER,
      version,
      url: url || null,
      port: port == null ? null : Number(port),
      token,
      enabled: enabled === true,
      tools: Array.isArray(tools) ? tools.slice() : [],
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, file);
    return doc;
  }

  function ensure() {
    const doc = read();
    if (doc) return doc;
    return write({ enabled: false });
  }

  function rotate() {
    const prev = read() || {};
    const doc = {
      schema: SCHEMA,
      server: SERVER,
      version,
      url: prev.url || null,
      port: prev.port == null ? null : Number(prev.port),
      token: newToken(),
      enabled: prev.enabled === true,
      tools: Array.isArray(prev.tools) ? prev.tools.slice() : [],
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, file);
    return doc;
  }

  function readToken() {
    return read()?.token || null;
  }

  /** Public status: never includes the token. */
  function summary() {
    const doc = read();
    return {
      path: file,
      schema: doc?.schema || SCHEMA,
      server: SERVER,
      version,
      url: doc?.url || null,
      port: doc?.port == null ? null : doc.port,
      enabled: doc?.enabled === true,
      tools: Array.isArray(doc?.tools) ? doc.tools.slice() : [],
    };
  }

  /** YAML for ~/.hermes/config.yaml (Hermes native MCP client). */
  function hermesConfig(urlOverride) {
    const doc = read();
    if (!doc?.token) throw new Error('MCP token is not available; start the server first');
    const url = urlOverride || doc.url || 'http://127.0.0.1:8790/mcp';
    const tools = Array.isArray(doc.tools) ? doc.tools : [];
    const lines = [
      'mcp_servers:',
      '  susurro:',
      `    url: "${url}"`,
      '    headers:',
      `      Authorization: "Bearer ${doc.token}"`,
      '    timeout: 180',
      '    supports_parallel_tool_calls: false',
      '    tools:',
      '      include:',
      ...tools.map((t) => `        - ${t}`),
      '      resources: false',
      '      prompts: false',
      '',
    ];
    return lines.join('\n');
  }

  return { file, read, write, ensure, rotate, readToken, summary, hermesConfig };
}

module.exports = { createDiscovery, SERVER };
