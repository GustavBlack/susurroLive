'use strict';
/** MCP tool registry: schemas, validation, and thin handlers over the controller. */
const { ToolError } = require('./errors');
const { PROFILES, SETTING_KEYS } = require('./controller');

const SOURCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'Stable source id (optional; generated when omitted)' },
    kind: { type: 'string', enum: ['mic', 'loopback'] },
    deviceId: { type: ['string', 'null'], description: 'Microphone deviceId, or screen source id for loopback' },
    label: { type: 'string' },
    gain: { type: 'number', minimum: 0, maximum: 4 },
    muted: { type: 'boolean' },
  },
  required: ['kind'],
};

function noExtra(args, allowed, tool) {
  for (const key of Object.keys(args || {})) {
    if (!allowed.includes(key)) throw new ToolError(`${tool}: unknown argument "${key}"`);
  }
}

function optString(args, key, max = 2048) {
  if (args[key] == null) return undefined;
  const v = String(args[key]);
  if (v.length > max) throw new ToolError(`${key} is too long`);
  return v;
}

function reqString(args, key, max = 2048) {
  const v = optString(args, key, max);
  if (!v) throw new ToolError(`${key} is required`);
  return v;
}

function optNumber(args, key) {
  if (args[key] == null) return undefined;
  const n = Number(args[key]);
  if (!Number.isFinite(n)) throw new ToolError(`${key} must be a number`);
  return n;
}

function optBool(args, key) {
  if (args[key] == null) return undefined;
  if (typeof args[key] !== 'boolean') throw new ToolError(`${key} must be a boolean`);
  return args[key];
}

function oneOf(args, key, values, fallback) {
  const v = args[key] == null ? fallback : String(args[key]);
  if (v != null && !values.includes(v)) throw new ToolError(`${key} must be one of: ${values.join(', ')}`);
  return v;
}

function optSources(args) {
  if (args.sources == null) return undefined;
  if (!Array.isArray(args.sources)) throw new ToolError('sources must be an array');
  return args.sources;
}

function createTools(controller) {
  return [
    {
      name: 'app_status',
      description: 'Read app version, renderer readiness, MCP endpoint, GPU/engine status, sessions root, current session, recording state, and transcription pipeline.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler(args) {
        noExtra(args, [], 'app_status');
        return controller.status();
      },
    },
    {
      name: 'sources_list',
      description: 'List available microphones and system-loopback screen sources, the current source array, and recording profiles.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => {
        noExtra(args, [], 'sources_list');
        return controller.sources();
      },
    },
    {
      name: 'session_list',
      description: 'List recording sessions under parentDir (defaults to the app sessions folder), newest first.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { parentDir: { type: 'string', description: 'Absolute parent folder' } },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler(args) {
        noExtra(args, ['parentDir'], 'session_list');
        return controller.listSessions(optString(args, 'parentDir'));
      },
    },
    {
      name: 'session_create',
      description: 'Create an empty session folder and make it active. Does not start recording.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          parentDir: { type: 'string', description: 'Absolute parent folder' },
          name: { type: 'string' },
          chunkSec: { type: 'number', minimum: 1, maximum: 3600 },
          engine: { type: 'string', enum: ['whisper', 'parakeet'] },
          model: { type: 'string' },
          language: { type: 'string' },
          device: { type: 'string', enum: ['auto', 'cuda', 'cpu'] },
          sources: { type: 'array', items: SOURCE_SCHEMA },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler(args) {
        noExtra(args, ['parentDir', 'name', 'chunkSec', 'engine', 'model', 'language', 'device', 'sources'], 'session_create');
        return controller.createSession({
          parentDir: optString(args, 'parentDir'),
          name: optString(args, 'name', 120),
          chunkSec: optNumber(args, 'chunkSec'),
          engine: oneOf(args, 'engine', ['whisper', 'parakeet']),
          model: optString(args, 'model', 120),
          language: optString(args, 'language', 32),
          device: oneOf(args, 'device', ['auto', 'cuda', 'cpu']),
          sources: optSources(args),
        });
      },
    },
    {
      name: 'session_open',
      description: 'Open an existing session folder and make it active in the app UI. Fails while recording.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { folder: { type: 'string', description: 'Absolute session folder containing session.json' } },
        required: ['folder'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler(args) {
        noExtra(args, ['folder'], 'session_open');
        return controller.openSession(reqString(args, 'folder'));
      },
    },
    {
      name: 'recording_start',
      description: 'Create or reuse a session and start capturing audio. profile=meeting adds the default microphone plus system loopback; voice adds only the default mic; system adds only loopback; custom uses the sources array. parentDir is the folder that will contain the timestamped session folder.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profile: { type: 'string', enum: Object.keys(PROFILES), default: 'meeting' },
          sources: { type: 'array', items: SOURCE_SCHEMA, description: 'Required for profile=custom' },
          parentDir: { type: 'string', description: 'Absolute parent folder' },
          name: { type: 'string' },
          newSession: { type: 'boolean' },
          chunkSec: { type: 'number', minimum: 1, maximum: 3600 },
          engine: { type: 'string', enum: ['whisper', 'parakeet'] },
          model: { type: 'string' },
          language: { type: 'string' },
          device: { type: 'string', enum: ['auto', 'cuda', 'cpu'] },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler(args) {
        noExtra(args, ['profile', 'sources', 'parentDir', 'name', 'newSession', 'chunkSec', 'engine', 'model', 'language', 'device'], 'recording_start');
        return controller.startRecording({
          profile: oneOf(args, 'profile', Object.keys(PROFILES), 'meeting'),
          sources: optSources(args),
          parentDir: optString(args, 'parentDir'),
          name: optString(args, 'name', 120),
          newSession: optBool(args, 'newSession'),
          chunkSec: optNumber(args, 'chunkSec'),
          engine: oneOf(args, 'engine', ['whisper', 'parakeet']),
          model: optString(args, 'model', 120),
          language: optString(args, 'language', 32),
          device: oneOf(args, 'device', ['auto', 'cuda', 'cpu']),
        });
      },
    },
    {
      name: 'recording_pause',
      description: 'Pause capture and the recording timer; closes the current chunk. Use recording_resume to continue the same session.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args) => {
        noExtra(args, [], 'recording_pause');
        return controller.pauseRecording();
      },
    },
    {
      name: 'recording_resume',
      description: 'Resume capture and the same recording timeline after recording_pause.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args) => {
        noExtra(args, [], 'recording_resume');
        return controller.resumeRecording();
      },
    },
    {
      name: 'recording_stop',
      description: 'Stop capture, close the final chunk, build full.wav, and enqueue the transcription tail. Set waitForTranscription=true to block until the pipeline is idle (max 120 s by default).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          waitForTranscription: { type: 'boolean', default: false },
          timeoutMs: { type: 'number', minimum: 1000, maximum: 600000, default: 120000 },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => {
        noExtra(args, ['waitForTranscription', 'timeoutMs'], 'recording_stop');
        return controller.stopRecording({
          waitForTranscription: optBool(args, 'waitForTranscription'),
          timeoutMs: optNumber(args, 'timeoutMs'),
        });
      },
    },
    {
      name: 'recording_status',
      description: 'Read recording/paused state, elapsed audio duration, sources, chunk statuses, pipeline depth, and transcription completion.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler(args) {
        noExtra(args, [], 'recording_status');
        return controller.status();
      },
    },
    {
      name: 'transcription_wait',
      description: 'Wait until the active session chunk pipeline is idle and every chunk is done or errored. Rejects while recording; stop first.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { timeoutMs: { type: 'number', minimum: 1000, maximum: 600000, default: 120000 } },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => {
        noExtra(args, ['timeoutMs'], 'transcription_wait');
        const t = await controller.waitForTranscription(optNumber(args, 'timeoutMs'));
        return { ok: true, transcription: t, status: controller.status() };
      },
    },
    {
      name: 'transcription_retry',
      description: 'Requeue one failed/outstanding chunk (index) or all outstanding/error chunks (all=true).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'number', minimum: 0 },
          all: { type: 'boolean' },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler(args) {
        noExtra(args, ['index', 'all'], 'transcription_retry');
        return controller.retryTranscription({
          index: optNumber(args, 'index'),
          all: optBool(args, 'all'),
        });
      },
    },
    {
      name: 'transcript_get',
      description: 'Return the transcript of the active session or a session folder. format=text returns prose; format=json returns words with global timestamps and segments. corrected defaults to true (matches the UI/export projection).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionFolder: { type: 'string', description: 'Absolute session folder; defaults to the active session' },
          format: { type: 'string', enum: ['text', 'json'], default: 'text' },
          corrected: { type: 'boolean', default: true },
          includeWords: { type: 'boolean', default: false },
          offset: { type: 'number', minimum: 0, default: 0 },
          limit: { type: 'number', minimum: 1, maximum: 10000, default: 2000 },
          maxChars: { type: 'number', minimum: 1000, maximum: 1000000, default: 100000 },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler(args) {
        noExtra(args, ['sessionFolder', 'format', 'corrected', 'includeWords', 'offset', 'limit', 'maxChars'], 'transcript_get');
        return controller.transcriptGet({
          sessionFolder: optString(args, 'sessionFolder'),
          format: oneOf(args, 'format', ['text', 'json'], 'text'),
          corrected: optBool(args, 'corrected'),
          includeWords: optBool(args, 'includeWords'),
          offset: optNumber(args, 'offset'),
          limit: optNumber(args, 'limit'),
          maxChars: optNumber(args, 'maxChars'),
        });
      },
    },
    {
      name: 'export_run',
      description: 'Write exports/full.txt, exports/full.json, or exports/full.wav for the active session or a session folder. Returns the absolute path and byte size.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['txt', 'json', 'audio'] },
          sessionFolder: { type: 'string' },
        },
        required: ['kind'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler(args) {
        noExtra(args, ['kind', 'sessionFolder'], 'export_run');
        return controller.exportSession({
          kind: oneOf(args, 'kind', ['txt', 'json', 'audio']),
          sessionFolder: optString(args, 'sessionFolder'),
        });
      },
    },
    {
      name: 'import_media',
      description: 'Transcode an audio or video file into a new session and start transcribing it. Returns the session and initial pipeline state.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mediaPath: { type: 'string', description: 'Absolute path to an audio/video file' },
          parentDir: { type: 'string', description: 'Absolute sessions parent folder' },
          name: { type: 'string' },
        },
        required: ['mediaPath'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args) => {
        noExtra(args, ['mediaPath', 'parentDir', 'name'], 'import_media');
        return controller.importMedia({
          mediaPath: reqString(args, 'mediaPath'),
          parentDir: optString(args, 'parentDir'),
          name: optString(args, 'name', 120),
        });
      },
    },
    {
      name: 'diarize_run',
      description: 'Run offline speaker diarization on the active, finished, fully transcribed session.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args) => {
        noExtra(args, [], 'diarize_run');
        return controller.diarize();
      },
    },
    {
      name: 'diarize_status',
      description: 'Read speaker-diarization availability, binary/model state, and whether a run is in flight.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler(args) {
        noExtra(args, [], 'diarize_status');
        return controller.diarizeStatus();
      },
    },
    {
      name: 'settings_set',
      description: 'Set recording defaults. Allowed keys: lastSessionParent, chunkSec, engine, model, language, device, vad, diarizeAutoOnStop. Never accepts LLM keys or the MCP token.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lastSessionParent: { type: 'string' },
          chunkSec: { type: 'number', minimum: 1, maximum: 3600 },
          engine: { type: 'string', enum: ['whisper', 'parakeet'] },
          model: { type: 'string' },
          language: { type: 'string' },
          device: { type: 'string', enum: ['auto', 'cuda', 'cpu'] },
          vad: { type: 'boolean' },
          diarizeAutoOnStop: { type: 'boolean' },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler(args) {
        const allowed = SETTING_KEYS;
        noExtra(args, allowed, 'settings_set');
        return controller.settingsSet(args);
      },
    },
  ];
}

module.exports = { createTools, SOURCE_SCHEMA };
