'use strict';
/**
 * Session store: a session is a folder containing session.json + audio/ + transcripts/,
 * plus AGENTS.md — the self-describing contract written into every folder (agent-manifest.js).
 * See docs/session-schema.md.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const agentManifest = require('./agent-manifest');
const { isValidBlock } = require('./diarize-join');

// Bump only for BREAKING shape changes (and add a migration). Optional additive blocks such
// as `diarization` keep v1: older builds preserve unknown keys when they re-save.
const SCHEMA_VERSION = 1;
const APP_VERSION = require('../../package.json').version;

function slug(s) {
  return String(s || 'session').replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'session';
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function ensureDirs(root) {
  for (const d of ['audio', 'transcripts', 'exports', 'temp']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
}

/** The agent contract file lives in every session folder so any agent can self-orient.
 *  Non-fatal by design: a missing manifest must never block recording. */
function manifestOpts() {
  return { appVersion: APP_VERSION, schemaVersion: SCHEMA_VERSION };
}

function ensureManifest(root) {
  const res = agentManifest.write(root, manifestOpts());
  if (!res.ok) console.error(`[session] AGENTS.md not written to ${root}: ${res.error}`);
  return res;
}

/** Validate + normalise an on-disk session object. Returns {ok, session, error}. */
function validate(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'not an object' };
  if (typeof raw.version !== 'number') return { ok: false, error: 'missing version' };
  if (raw.version > SCHEMA_VERSION) {
    return { ok: false, error: `session schema v${raw.version} is newer than this app supports (v${SCHEMA_VERSION})` };
  }
  if (!Array.isArray(raw.chunks)) raw.chunks = [];
  if (!Array.isArray(raw.sources)) raw.sources = [];
  if (!raw.transcript || typeof raw.transcript !== 'object') {
    raw.transcript = { language: null, fullText: '', words: [], segments: [] };
  }
  if (!Array.isArray(raw.transcript.words)) raw.transcript.words = [];
  if (!Array.isArray(raw.transcript.segments)) raw.transcript.segments = [];
  if (!Array.isArray(raw.exports)) raw.exports = [];

  // Speaker diarization is optional, re-runnable data: a malformed block is dropped rather
  // than refusing to open the session.
  if (raw.diarization != null && !isValidBlock(raw.diarization)) {
    console.warn('[session] dropping malformed diarization block');
    delete raw.diarization;
  }

  // Crash recovery: anything mid-flight goes back to the queue.
  for (const c of raw.chunks) {
    if (c.status === 'running' || c.status === 'queued') c.status = 'pending';
  }
  return { ok: true, session: raw };
}

function createSession({ parentDir, name, settings, gpu, model, chunkSec, sources }) {
  const folderName = `${stamp()}_${slug(name)}`;
  const root = path.join(parentDir, folderName);
  fs.mkdirSync(root, { recursive: true });
  ensureDirs(root);

  const now = new Date().toISOString();
  const session = {
    version: SCHEMA_VERSION,
    id: crypto.randomUUID(),
    name: name || 'Untitled Session',
    createdAt: now,
    updatedAt: now,
    folder: root,
    environment: {
      gpu: gpu ? { vendor: gpu.vendor, model: gpu.model, cuda: gpu.cuda, compute: gpu.compute } : null,
      os: `${process.platform} ${process.arch}`,
      app: APP_VERSION,
    },
    recording: {
      startedAt: null,
      stoppedAt: null,
      durationSec: 0,
      sampleRate: 48000,
      channels: 1,
      chunkSec: chunkSec || 60,
      sources: sources || [],
    },
    model: {
      name: model?.name || settings?.model || 'small.en',
      engine: model?.engine || settings?.engine || 'whisper',
      language: settings?.language || 'en',
      device: model?.device || (gpu?.accelerated ? 'cuda' : 'cpu'),
      vad: settings?.vad !== false,
    },
    chunks: [],
    transcript: { language: null, fullText: '', words: [], segments: [] },
    exports: [],
  };

  writeSession(root, session);
  ensureManifest(root);
  return session;
}

function writeSession(root, session) {
  session.updatedAt = new Date().toISOString();
  const tmp = path.join(root, 'session.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2));
  fs.renameSync(tmp, path.join(root, 'session.json'));
}

function openSession(folder) {
  const file = path.join(folder, 'session.json');
  if (!fs.existsSync(file)) return { ok: false, error: `no session.json in ${folder}` };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, error: `session.json is not valid JSON: ${e.message}` };
  }
  const v = validate(raw);
  if (!v.ok) return v;
  v.session.folder = folder;
  return v;
}

/**
 * Read-modify-write a session that is NOT the active one (e.g. a diarize run that finished
 * after the user switched sessions). Returns {ok, session} or {ok:false, error}.
 */
function updateSessionFile(folder, mutate) {
  const r = openSession(folder);
  if (!r.ok) return r;
  mutate(r.session);
  writeSession(folder, r.session);
  return { ok: true, session: r.session };
}

function listSessions(parentDir) {
  const out = [];
  try {
    for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(parentDir, entry.name);
      const file = path.join(folder, 'session.json');
      if (!fs.existsSync(file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        out.push({
          folder,
          name: raw.name,
          createdAt: raw.createdAt,
          durationSec: raw.recording?.durationSec ?? 0,
          chunks: raw.chunks?.length ?? 0,
          transcribed: (raw.chunks || []).filter((c) => c.status === 'done').length,
        });
      } catch { /* skip unreadable */ }
    }
  } catch { /* parent missing */ }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

module.exports = {
  createSession, openSession, writeSession, updateSessionFile, listSessions, ensureDirs, ensureManifest, SCHEMA_VERSION,
};
