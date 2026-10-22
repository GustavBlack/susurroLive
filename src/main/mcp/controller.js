'use strict';
/**
 * MCP action layer. All state transitions go through the same main-process actions the IPC
 * handlers use; capture transitions are delegated to the renderer's fixed command channel.
 */
const fs = require('fs');
const path = require('path');
const { ToolError } = require('./errors');
const { wordSpeakersFor } = require('../diarize-join');

const PROFILES = Object.freeze({
  meeting: 'default microphone + system loopback',
  voice: 'default microphone only',
  system: 'system loopback only',
  custom: 'explicit sources array',
});

const SETTING_KEYS = [
  'lastSessionParent', 'chunkSec', 'engine', 'model', 'language', 'device', 'vad', 'diarizeAutoOnStop',
];

const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function asAbsolute(value, name) {
  if (value == null || value === '') return null;
  const s = String(value);
  if (!path.isAbsolute(s)) throw new ToolError(`${name} must be an absolute path`);
  return path.resolve(s);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createController(deps) {
  const {
    appVersion, settings, store, exporters, gpu,
    getActive, getPipeline, getRecorder, isRecording, isImporting,
    getRendererReady, rendererControl, desktopCapturer, send,
    persist, activateSession, createSessionFor, runExport, runImport,
    diarizeActive, getDiarizeStatus, getEngineStatus, getMcpInfo, applySettingsPatch,
  } = deps;

  function activeSession() {
    return getActive();
  }

  function chunkState(session, pipeline) {
    const chunks = session?.chunks || [];
    const errors = chunks.filter((c) => c.status === 'error').map((c) => c.index);
    const outstanding = chunks.filter((c) => !['done', 'error'].includes(c.status)).length;
    const remaining = pipeline ? Number(pipeline.remaining) || 0 : outstanding;
    const running = pipeline ? Number(pipeline.running) || 0 : 0;
    return {
      chunks: chunks.length,
      done: chunks.filter((c) => c.status === 'done').length,
      errors,
      outstanding,
      remaining,
      running,
      complete: chunks.length > 0 && outstanding === 0 && remaining === 0 && running === 0,
    };
  }

  function sessionSummary(session) {
    if (!session) return null;
    const pipe = session === activeSession() ? getPipeline() : null;
    const t = chunkState(session, pipe);
    return {
      folder: session.folder,
      name: session.name,
      id: session.id,
      createdAt: session.createdAt,
      durationSec: Number(session.recording?.durationSec || 0),
      chunks: t.chunks,
      done: t.done,
      words: session.transcript?.words?.length || 0,
      complete: t.complete,
      sources: session.recording?.sources || [],
      model: session.model || null,
    };
  }

  function recordingSummary() {
    const recording = isRecording();
    const rec = getRecorder();
    const active = activeSession();
    return {
      active: recording,
      paused: !!(rec && rec.paused),
      durationSec: rec ? Number(rec.recordedSeconds.toFixed(2)) : Number(active?.recording?.durationSec || 0),
      startedAt: active?.recording?.startedAt || null,
      sources: active?.recording?.sources || [],
      chunkSec: active?.recording?.chunkSec || null,
    };
  }

  function transcriptionSummary(session) {
    const pipe = session === activeSession() ? getPipeline() : null;
    return chunkState(session, pipe);
  }

  function status() {
    const active = activeSession();
    const mcp = getMcpInfo ? getMcpInfo() : null;
    return {
      ok: true,
      appVersion,
      rendererReady: getRendererReady(),
      mcp: mcp ? {
        enabled: mcp.enabled,
        running: mcp.running,
        url: mcp.url,
        port: mcp.port,
        error: mcp.error,
        toolCount: mcp.toolCount,
        discoveryPath: mcp.discoveryPath,
      } : null,
      gpu: gpu ? {
        vendor: gpu.vendor, model: gpu.model, cuda: gpu.cuda, compute: gpu.compute, accelerated: gpu.accelerated,
      } : null,
      engines: getEngineStatus ? getEngineStatus() : null,
      sessionsRoot: settings.get('lastSessionParent') || null,
      settings: Object.fromEntries(SETTING_KEYS.map((k) => [k, settings.get(k)])),
      session: sessionSummary(active),
      recording: recordingSummary(),
      pipeline: {
        remaining: getPipeline()?.remaining || 0,
        running: getPipeline()?.running || 0,
        concurrency: getPipeline()?.concurrency || 0,
      },
      transcription: transcriptionSummary(active),
    };
  }

  async function sources() {
    if (!getRendererReady()) throw new ToolError('susurroLive UI is still starting; retry in a moment');
    const r = await rendererControl.call('sources.list', {}, 30000);
    if (!r || !r.ok) throw new ToolError(r?.error || 'could not enumerate audio sources');
    return {
      ok: true,
      microphones: r.microphones || [],
      loopbacks: r.loopbacks || [],
      current: r.current || [],
      profiles: PROFILES,
    };
  }

  function listSessions(parentDir) {
    const parent = parentDir ? asAbsolute(parentDir, 'parentDir') : (settings.get('lastSessionParent') || null);
    if (!parent) throw new ToolError('no sessions folder chosen yet; pass parentDir or set lastSessionParent');
    const sessions = store.listSessions(parent);
    return { ok: true, parentDir: parent, sessions };
  }

  function applyOverrides(opts) {
    const patch = {};
    if (opts.engine != null) patch.engine = opts.engine;
    if (opts.model != null) patch.model = opts.model;
    if (opts.language != null) patch.language = opts.language;
    if (opts.chunkSec != null) patch.chunkSec = opts.chunkSec;
    if (opts.device != null) patch.device = opts.device;
    if (Object.keys(patch).length) applySettingsPatch(patch);
    return patch;
  }

  function createSession(opts = {}) {
    if (isRecording()) throw new ToolError('stop recording before creating another session');
    if (isImporting()) throw new ToolError('wait for the import to finish');
    const parentDir = asAbsolute(opts.parentDir, 'parentDir');
    const name = opts.name == null ? undefined : String(opts.name).slice(0, 120);
    if (opts.chunkSec != null) {
      const n = Number(opts.chunkSec);
      if (!Number.isFinite(n) || n <= 0 || n > 3600) throw new ToolError('chunkSec must be between 1 and 3600');
    }
    applyOverrides(opts);
    const r = createSessionFor({
      parentDir: parentDir || undefined,
      name,
      chunkSec: opts.chunkSec,
      sources: Array.isArray(opts.sources) ? opts.sources : [],
    });
    if (!r.ok) throw new ToolError(r.error || 'could not create session');
    send('sessionChanged', { folder: activeSession()?.folder || null });
    return { ok: true, session: sessionSummary(activeSession()) };
  }

  function openSession(folder) {
    const dir = asAbsolute(folder, 'folder');
    if (!dir) throw new ToolError('folder is required');
    if (isRecording()) throw new ToolError('stop recording before opening another session');
    const r = activateSession(dir);
    if (!r.ok) throw new ToolError(r.error || 'could not open session');
    send('sessionChanged', { folder: dir });
    return { ok: true, session: sessionSummary(activeSession()) };
  }

  async function resolveSources(profile, supplied) {
    const p = profile || 'meeting';
    if (!Object.prototype.hasOwnProperty.call(PROFILES, p)) {
      throw new ToolError(`profile must be one of: ${Object.keys(PROFILES).join(', ')}`);
    }
    if (p === 'custom' && (!Array.isArray(supplied) || supplied.length === 0)) {
      throw new ToolError('profile "custom" requires a non-empty sources array');
    }
    if (Array.isArray(supplied) && supplied.length > 0) return normalizeSources(supplied);

    if (p === 'voice') {
      return [{
        id: 'src_mic', kind: 'mic', deviceId: null, label: 'Default microphone', gain: 1, muted: false,
      }];
    }

    const screens = await desktopCapturer.getSources({
      types: ['screen'], thumbnailSize: { width: 0, height: 0 },
    });
    if (!screens.length) throw new ToolError('no screen source available for system audio');
    const loop = {
      id: 'src_sys', kind: 'loopback', deviceId: screens[0].id,
      label: 'System Audio', gain: 1, muted: false,
    };
    if (p === 'system') return [loop];
    return [{
      id: 'src_mic', kind: 'mic', deviceId: null, label: 'Default microphone', gain: 1, muted: false,
    }, loop];
  }

  async function normalizeSources(supplied) {
    const needsScreen = supplied.some((s) => s && s.kind === 'loopback');
    const screens = needsScreen
      ? await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      : [];
    if (needsScreen && !screens.length) throw new ToolError('no screen source available for system audio');

    const out = [];
    const ids = new Set();
    let mics = 0;
    let loops = 0;
    for (const raw of supplied) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError('each source must be an object');
      if (raw.kind !== 'mic' && raw.kind !== 'loopback') throw new ToolError('source.kind must be "mic" or "loopback"');
      if (raw.kind === 'loopback') {
        loops++;
        if (loops > 1) throw new ToolError('only one system loopback source is supported');
      } else {
        mics++;
      }
      let id = raw.id == null || raw.id === '' ? null : String(raw.id);
      if (!id) id = raw.kind === 'mic' ? (mics === 1 ? 'src_mic' : `src_mic_${mics}`) : 'src_sys';
      if (ids.has(id)) throw new ToolError(`duplicate source id: ${id}`);
      ids.add(id);

      let deviceId = raw.deviceId == null || raw.deviceId === '' ? null : String(raw.deviceId);
      if (raw.kind === 'loopback' && !deviceId) {
        if (!screens.length) throw new ToolError('no screen source available for system audio');
        deviceId = screens[0].id;
      }
      const label = raw.label == null || raw.label === ''
        ? (raw.kind === 'mic' ? 'Microphone' : 'System Audio')
        : String(raw.label).slice(0, 120);
      const gain = raw.gain == null ? 1 : Number(raw.gain);
      if (!Number.isFinite(gain) || gain < 0 || gain > 4) throw new ToolError('source.gain must be between 0 and 4');
      out.push({
        id, kind: raw.kind, deviceId, label,
        gain: Number(gain.toFixed(2)),
        muted: raw.muted === true,
      });
    }
    if (!out.length) throw new ToolError('at least one source is required');
    return out;
  }

  async function startRecording(opts = {}) {
    if (isRecording()) throw new ToolError('recording is already active; use recording_pause/resume or recording_stop');
    if (isImporting()) throw new ToolError('wait for the import to finish');
    const parentDir = asAbsolute(opts.parentDir, 'parentDir');
    const name = opts.name == null ? undefined : String(opts.name).slice(0, 120);
    const chunkSec = opts.chunkSec == null ? null : Number(opts.chunkSec);
    if (chunkSec != null && (!Number.isFinite(chunkSec) || chunkSec <= 0 || chunkSec > 3600)) {
      throw new ToolError('chunkSec must be between 1 and 3600');
    }
    applyOverrides(opts);

    let active = activeSession();
    const hasChunks = !!active && Array.isArray(active.chunks) && active.chunks.length > 0;
    let newSession;
    if (opts.newSession === true) newSession = true;
    else if (opts.newSession === false) {
      if (!active) throw new ToolError('newSession=false but there is no active session');
      if (hasChunks) throw new ToolError('newSession=false but the active session already has chunks');
      newSession = false;
    } else {
      newSession = !active || hasChunks || !!parentDir || !!name;
    }

    if (newSession) {
      const r = createSessionFor({
        parentDir: parentDir || undefined,
        name,
        chunkSec: chunkSec || undefined,
        sources: [],
      });
      if (!r.ok) throw new ToolError(r.error || 'could not create session');
      send('sessionChanged', { folder: activeSession()?.folder || null });
      active = activeSession();
    } else {
      active = activeSession();
      if (chunkSec != null) active.recording.chunkSec = chunkSec;
      persist();
    }

    const resolved = await resolveSources(opts.profile || 'meeting', opts.sources);
    const r = await rendererControl.call('recording.start', { sources: resolved }, 120000);
    if (!r || !r.ok) {
      throw new ToolError(`${r?.error || 'capture failed'} (session: ${active?.folder || 'none'})`);
    }

    const usedCustomSources = Array.isArray(opts.sources) && opts.sources.length > 0;
    return {
      ok: true,
      sessionFolder: active.folder,
      name: active.name,
      profile: usedCustomSources ? 'custom' : (opts.profile || 'meeting'),
      sources: resolved,
      sampleRate: r.sampleRate || active.recording.sampleRate,
      chunkSec: active.recording.chunkSec,
      startedAt: active.recording.startedAt,
      status: status(),
    };
  }

  async function pauseRecording() {
    if (!isRecording()) throw new ToolError('no active recording');
    const r = await rendererControl.call('recording.pause', {}, 30000);
    if (!r || !r.ok) throw new ToolError(r?.error || 'pause failed');
    return { ok: true, recording: recordingSummary(), status: status() };
  }

  async function resumeRecording() {
    if (!isRecording()) throw new ToolError('no active recording');
    const r = await rendererControl.call('recording.resume', {}, 30000);
    if (!r || !r.ok) throw new ToolError(r?.error || 'resume failed');
    return { ok: true, recording: recordingSummary(), status: status() };
  }

  async function waitForTranscription(timeoutMs = 120000) {
    if (isRecording()) throw new ToolError('stop recording before waiting for transcription');
    const active = activeSession();
    if (!active) throw new ToolError('no active session');
    if (!active.chunks?.length) throw new ToolError('no chunks have been captured yet');
    const folder = active.folder;
    const timeout = Math.max(1000, Math.min(Number(timeoutMs) || 120000, 600000));
    const deadline = Date.now() + timeout;
    let last = transcriptionSummary(active);
    while (Date.now() < deadline) {
      const current = activeSession();
      if (!current || !samePath(current.folder, folder)) {
        throw new ToolError('the active session changed while waiting for transcription');
      }
      last = transcriptionSummary(current);
      if (last.complete) return last;
      await delay(250);
    }
    throw new ToolError(
      `transcription did not finish within ${timeout} ms; ${last.remaining || last.outstanding} chunk(s) remain`,
    );
  }

  async function stopRecording(opts = {}) {
    if (!isRecording()) {
      return { ok: true, alreadyStopped: true, recording: recordingSummary(), transcription: transcriptionSummary(activeSession()) };
    }
    const r = await rendererControl.call('recording.stop', {}, 60000);
    if (!r || !r.ok) throw new ToolError(r?.error || 'stop failed');
    const active = activeSession();
    let transcription = transcriptionSummary(active);
    if (opts.waitForTranscription === true) {
      transcription = await waitForTranscription(opts.timeoutMs || 120000);
    }
    const full = active ? path.join(active.folder, 'audio', 'full.wav') : null;
    return {
      ok: true,
      sessionFolder: active?.folder || null,
      durationSec: active?.recording?.durationSec || 0,
      chunks: active?.chunks?.length || 0,
      audioPath: full && fs.existsSync(full) ? full : null,
      transcription,
    };
  }

  function retryTranscription(opts = {}) {
    const pipeline = getPipeline();
    const active = activeSession();
    if (!pipeline || !active) throw new ToolError('no active session');
    if (opts.index != null) {
      const index = Number(opts.index);
      const chunk = active.chunks.find((c) => c.index === index);
      if (!chunk) throw new ToolError(`no chunk ${index}`);
      chunk.status = 'queued';
      chunk.error = null;
      pipeline.enqueue(index);
      persist();
    } else if (opts.all === true) {
      pipeline.enqueueAllOutstanding();
    } else {
      throw new ToolError('pass index or all=true');
    }
    return { ok: true, transcription: transcriptionSummary(active) };
  }

  function loadSession(folder) {
    if (folder == null) {
      const active = activeSession();
      if (!active) throw new ToolError('no active session');
      return active;
    }
    const dir = asAbsolute(folder, 'sessionFolder');
    const active = activeSession();
    if (active && samePath(active.folder, dir)) return active;
    const r = store.openSession(dir);
    if (!r.ok) throw new ToolError(r.error || 'could not open session');
    return r.session;
  }

  function transcriptGet(opts = {}) {
    const session = loadSession(opts.sessionFolder);
    const corrected = opts.corrected !== false;
    const words = corrected ? exporters.projectedWords(session) : (session.transcript?.words || []);
    const t = transcriptionSummary(session);
    const format = opts.format === 'json' ? 'json' : 'text';
    const includeWords = opts.includeWords === true || format === 'json';
    const offset = Math.max(0, Number(opts.offset) || 0);
    const limit = Math.max(1, Math.min(Number(opts.limit) || 2000, 10000));
    const text = exporters.joinWords(words);
    const maxChars = Math.max(1000, Math.min(Number(opts.maxChars) || 100000, 1000000));
    let pathOut = null;
    let truncated = false;
    let textOut = text;
    if (text.length > maxChars) {
      const dir = path.join(session.folder, 'exports');
      fs.mkdirSync(dir, { recursive: true });
      pathOut = path.join(dir, 'full.txt');
      exporters.exportTxt(session, pathOut);
      textOut = text.slice(0, maxChars);
      truncated = true;
    }
    const speakers = wordSpeakersFor(session);
    return {
      ok: true,
      sessionFolder: session.folder,
      name: session.name,
      durationSec: Number(session.recording?.durationSec || 0),
      language: session.transcript?.language || null,
      corrected,
      complete: t.complete,
      remaining: t.remaining,
      running: t.running,
      errors: t.errors,
      wordCount: words.length,
      speakers: Array.isArray(speakers) ? speakers.filter(Boolean).length : 0,
      diarization: session.diarization ? { speakers: session.diarization.speakers, createdAt: session.diarization.createdAt } : null,
      format,
      text: textOut,
      ...(includeWords ? {
        words: words.slice(offset, offset + limit),
        offset,
        limit,
        hasMore: offset + limit < words.length,
      } : {}),
      ...(format === 'json' ? {
        segments: session.transcript?.segments || [],
        wordSpeakers: speakers,
      } : {}),
      ...(pathOut ? { path: pathOut, truncated: true } : {}),
    };
  }

  function exportSession(opts = {}) {
    const kind = opts.kind;
    if (!['txt', 'json', 'audio'].includes(kind)) throw new ToolError('kind must be txt, json, or audio');
    const session = loadSession(opts.sessionFolder);
    if (kind === 'audio' && session === activeSession() && isRecording()) {
      throw new ToolError('stop recording before exporting audio');
    }
    const r = runExport(kind, session);
    if (!r.ok) throw new ToolError(r.error || 'export failed');
    return { ok: true, kind, path: r.path, bytes: r.bytes, sessionFolder: session.folder };
  }

  async function importMedia(opts = {}) {
    const mediaPath = asAbsolute(opts.mediaPath, 'mediaPath');
    if (!mediaPath) throw new ToolError('mediaPath is required');
    if (!fs.existsSync(mediaPath)) throw new ToolError('media file not found');
    const parentDir = asAbsolute(opts.parentDir, 'parentDir');
    if (isRecording()) throw new ToolError('stop recording before importing');
    const r = await runImport({ mediaPath, parentDir: parentDir || undefined, name: opts.name });
    if (!r.ok) throw new ToolError(r.error || 'import failed');
    send('sessionChanged', { folder: activeSession()?.folder || null });
    return {
      ok: true,
      session: sessionSummary(activeSession()),
      seconds: r.seconds,
      chunks: r.chunks,
      transcription: transcriptionSummary(activeSession()),
    };
  }

  async function diarize() {
    const r = await diarizeActive();
    if (!r.ok) throw new ToolError(r.error || 'speaker diarization failed');
    return { ok: true, ...r, status: getDiarizeStatus() };
  }

  function diarizeStatus() {
    return { ok: true, ...getDiarizeStatus() };
  }

  function settingsSet(patch = {}) {
    const next = {};
    for (const key of SETTING_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
    }
    if (!Object.keys(next).length) throw new ToolError(`no supported setting; allowed: ${SETTING_KEYS.join(', ')}`);
    if (next.chunkSec != null) {
      const n = Number(next.chunkSec);
      if (!Number.isFinite(n) || n <= 0 || n > 3600) throw new ToolError('chunkSec must be between 1 and 3600');
      next.chunkSec = n;
    }
    if (next.engine != null && !['whisper', 'parakeet'].includes(next.engine)) {
      throw new ToolError('engine must be whisper or parakeet');
    }
    if (next.lastSessionParent != null) next.lastSessionParent = asAbsolute(next.lastSessionParent, 'lastSessionParent');
    applySettingsPatch(next);
    return { ok: true, settings: Object.fromEntries(SETTING_KEYS.map((k) => [k, settings.get(k)])) };
  }

  return {
    status, sources, listSessions, createSession, openSession,
    startRecording, pauseRecording, resumeRecording, stopRecording,
    waitForTranscription, retryTranscription, transcriptGet, exportSession,
    importMedia, diarize, diarizeStatus, settingsSet,
    _helpers: { chunkState, sessionSummary, normalizeSources, resolveSources },
  };
}

module.exports = { createController, PROFILES, SETTING_KEYS };
