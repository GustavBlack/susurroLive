'use strict';
/** Persisted app settings (userData/settings.json). */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  lastSessionParent: null,
  engine: 'whisper',         // whisper | parakeet (falls back to whisper when unavailable)
  model: 'small.en',
  language: 'en',
  chunkSec: 60,
  vad: true,
  device: 'auto',            // auto | cuda | cpu
  lastSources: [],           // [{kind, deviceId, label, gain, muted}]
  showGpuBanner: true,
  diarizeAutoOnStop: false,  // identify speakers once a stopped/imported session is transcribed
  theme: 'default',          // v1.5 theme id — see src/renderer/theme/themes.js
  themeMode: 'dark',         // dark | light
  llmCheckup: false,         // master opt-in; the AI checkup is dead unless true
  llmEndpoint: '',           // e.g. http://127.0.0.1:1234/v1 (base, no /chat/completions)
  llmApiKey: '',             // '' = endpoint requires no key
  llmModel: '',              // model id as the endpoint names it
  llmContextTokens: 8192,    // overwritten by probe when the endpoint exposes it
  llmThinking: 'auto',       // auto | off (off skips the think-tag strip)
  mcpEnabled: true,          // local agent control surface (loopback + bearer token)
  mcpPort: 8790,             // fixed so Hermes configs stay valid across launches
};

function createSettings(userDataDir) {
  const file = path.join(userDataDir, 'settings.json');
  let data = { ...DEFAULTS };

  try {
    if (fs.existsSync(file)) {
      data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
  } catch { /* corrupt -> defaults */ }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch { /* non-fatal */ }
  }

  return {
    file,
    all: () => ({ ...data }),
    get: (k) => data[k],
    set(patch) {
      Object.assign(data, patch);
      persist();
      return { ...data };
    },
  };
}

module.exports = { createSettings, DEFAULTS };
