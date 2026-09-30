'use strict';
/** Renderer <-> main bridge. The renderer never sees Node. */
const { contextBridge, ipcRenderer } = require('electron');

// Only these main-process events reach the renderer; add new ones here.
const EVENTS = [
  'chunk', 'chunkDone', 'chunks', 'pipeline', 'transcript',
  'recordState', 'status', 'log', 'import',
  'diarizeProgress', 'diarizeDone', 'diarizeError',
  'parakeetProgress', 'parakeetDone', 'parakeetError',
  'updateStatus',
];

const listeners = new Map();
for (const evt of EVENTS) {
  ipcRenderer.on(`evt:${evt}`, (_e, payload) => {
    for (const cb of listeners.get(evt) || []) {
      try { cb(payload); } catch (err) { console.error(err); }
    }
  });
}

contextBridge.exposeInMainWorld('susurro', {
  // ---- app / diagnostics ----
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    paths: () => ipcRenderer.invoke('app:paths'),
    ready: () => ipcRenderer.send('app:ready'),
  },

  gpu: { probe: () => ipcRenderer.invoke('gpu:probe') },
  engine: { status: () => ipcRenderer.invoke('engine:status') },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },

  // ---- capture ----
  capture: {
    desktopSources: () => ipcRenderer.invoke('capture:desktopSources'),
    pcm: (arrayBuffer) => ipcRenderer.send('audio:pcm', arrayBuffer),
  },

  // ---- sessions ----
  session: {
    pickFolder: () => ipcRenderer.invoke('session:pickFolder'),
    create: (opts) => ipcRenderer.invoke('session:create', opts),
    open: (folder) => ipcRenderer.invoke('session:open', folder),
    openDialog: () => ipcRenderer.invoke('session:openDialog'),
    list: (parent) => ipcRenderer.invoke('session:list', parent),
    current: () => ipcRenderer.invoke('session:current'),
    buildFull: () => ipcRenderer.invoke('session:buildFull'),
    rename: (name) => ipcRenderer.invoke('session:rename', name),
    close: () => ipcRenderer.invoke('session:close'),
  },

  // ---- import prerecorded media ----
  import: {
    pickMedia: () => ipcRenderer.invoke('import:pickMedia'),
    run: (opts) => ipcRenderer.invoke('import:run', opts),
  },

  // ---- recording ----
  record: {
    start: (opts) => ipcRenderer.invoke('record:start', opts),
    pause: () => ipcRenderer.invoke('record:pause'),
    resume: () => ipcRenderer.invoke('record:resume'),
    stop: () => ipcRenderer.invoke('record:stop'),
  },

  // ---- pipeline ----
  pipeline: {
    retry: (index) => ipcRenderer.invoke('pipeline:retry', index),
    retryAll: () => ipcRenderer.invoke('pipeline:retryAll'),
    status: () => ipcRenderer.invoke('pipeline:status'),
  },

  // ---- speaker diarization ----
  diarize: {
    run: () => ipcRenderer.invoke('diarize:run'),
    cancel: () => ipcRenderer.invoke('diarize:cancel'),
    status: () => ipcRenderer.invoke('diarize:status'),
  },

  // ---- models ----
  models: {
    catalog: () => ipcRenderer.invoke('models:catalog'),
    download: (id) => ipcRenderer.invoke('models:download', id),
    cancel: (id) => ipcRenderer.invoke('models:cancel', id),
    remove: (id) => ipcRenderer.invoke('models:remove', id),
  },

  // ---- parakeet provisioning ----
  parakeet: {
    provisioned: () => ipcRenderer.invoke('parakeet:provisioned'),
    download: () => ipcRenderer.invoke('parakeet:download'),
    cancel: () => ipcRenderer.invoke('parakeet:cancel'),
  },

  // ---- in-app updates ----
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
  },

  // ---- export / shell ----
  exportRun: (kind) => ipcRenderer.invoke('export:run', kind),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  copyText: (t) => ipcRenderer.invoke('shell:copy', t),

  // ---- events ----
  on(evt, cb) {
    if (!listeners.has(evt)) listeners.set(evt, []);
    listeners.get(evt).push(cb);
    return () => {
      const arr = listeners.get(evt) || [];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    };
  },
});
