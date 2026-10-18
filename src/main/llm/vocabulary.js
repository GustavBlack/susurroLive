'use strict';
/** Vocabulary profiles — a plain, user-editable <userData>/vocabulary.json. */

const fs = require('fs');
const path = require('path');

const VERSION = 1;

const SEED = {
  version: VERSION,
  profiles: [
    {
      id: 'default',
      name: 'Default',
      active: true,
      terms: ['susurroLive', 'whisper.cpp', 'sm_120', 'PartUV'],
    },
  ],
};

function createVocabulary(dir) {
  const file = path.join(dir, 'vocabulary.json');

  function write(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  /** Always re-reads (no cache — the user owns the file). Never throws. */
  function load() {
    try {
      if (!fs.existsSync(file)) {
        write(SEED);
        return { ok: true, data: JSON.parse(JSON.stringify(SEED)), file };
      }
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data || !Array.isArray(data.profiles)) {
        return { ok: false, data: JSON.parse(JSON.stringify(SEED)), file };
      }
      return { ok: true, data, file };
    } catch {
      return { ok: false, data: JSON.parse(JSON.stringify(SEED)), file };
    }
  }

  function save(data) {
    write(data);
    return { ok: true, data, file };
  }

  /** Active profiles concatenated in file order, deduped case-insensitively. */
  function activeTerms() {
    const { ok, data } = load();
    if (!ok) return []; // malformed file: never feed garbage into a checkup run
    const seen = new Set();
    const out = [];
    for (const p of data.profiles || []) {
      if (!p || p.active !== true || !Array.isArray(p.terms)) continue;
      for (const t of p.terms) {
        if (typeof t !== 'string') continue;
        const trimmed = t.trim();
        if (!trimmed) continue;
        const k = trimmed.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(trimmed);
      }
    }
    return out;
  }

  function upsertProfile(profile) {
    const { data } = load();
    if (!profile || typeof profile.id !== 'string' || !profile.id) {
      return { ok: false, data, file };
    }
    const idx = data.profiles.findIndex((p) => p && p.id === profile.id);
    const next = {
      id: profile.id,
      name: typeof profile.name === 'string' ? profile.name : profile.id,
      active: profile.active === true,
      terms: Array.isArray(profile.terms) ? profile.terms.filter((t) => typeof t === 'string') : [],
    };
    if (idx === -1) data.profiles.push(next);
    else data.profiles[idx] = next;
    save(data);
    return { ok: true, data, file };
  }

  function setActive(id, active) {
    const { data } = load();
    const p = data.profiles.find((x) => x && x.id === id);
    if (!p) return { ok: false, data, file };
    p.active = active === true;
    save(data);
    return { ok: true, data, file };
  }

  function revealFile() {
    // Import electron lazily so the module stays testable in plain node.
    // eslint-disable-next-line global-require
    const { shell } = require('electron');
    load(); // ensure the file exists before revealing
    shell.showItemInFolder(file);
  }

  return { file, load, save, activeTerms, upsertProfile, setActive, revealFile };
}

module.exports = { createVocabulary, SEED, VERSION };
