// theme.js — v1.9.0 appearance and skin engine (renderer side).
// Tech Moca is the base palette. A skin is a chroma-only layer: the floor, lines,
// text, type, spacing, radius, shadow and motion stay locked. The visualizer and
// speaker marks follow the active skin in the same frame.

import { TECH_MOCA } from './theme/tech-moca.js';
import { SKINS, normalizeSkin, skinPalette } from './theme/skins.js';

let vizRef = null;
let animTimer = null;
let currentSkin = '';

function clearAnim() {
  document.documentElement.classList.remove('mode-anim', 'skin-anim');
}

/** Paint the dark / light control. A segmented pill, not a theme grid. */
export function renderModePicker(root, { mode, onMode }) {
  root.innerHTML = '';
  const seg = document.createElement('div');
  seg.className = 'segs';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Appearance mode');
  for (const m of ['dark', 'light']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn' + (m === mode ? ' on' : '');
    b.textContent = m === 'dark' ? 'Dark' : 'Light';
    b.setAttribute('aria-pressed', m === mode ? 'true' : 'false');
    b.onclick = () => onMode(m);
    seg.appendChild(b);
  }
  root.appendChild(seg);
}

/** Paint the skin list. A vertical list of pills, not a grid of mini-palettes. */
export function renderSkinPicker(root, { skin, onSkin }) {
  root.innerHTML = '';
  root.setAttribute('role', 'radiogroup');
  root.setAttribute('aria-label', 'Colour skin');

  const current = normalizeSkin(skin);
  const entries = [
    {
      id: '',
      name: 'Tech Moca',
      note: 'Graphite floor, off-white accent',
      swatch: [TECH_MOCA.dark.accent, TECH_MOCA.dark.record, TECH_MOCA.dark.success],
    },
    ...SKINS.map((s) => ({ id: s.id, name: s.name, note: s.note, swatch: s.swatch })),
  ];

  for (const entry of entries) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'skin-row' + (entry.id === current ? ' is-active' : '');
    b.dataset.skin = entry.id;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', entry.id === current ? 'true' : 'false');
    b.setAttribute('aria-label', `${entry.name} · ${entry.note}`);

    const sw = document.createElement('span');
    sw.className = 'skin-swatch';
    sw.setAttribute('aria-hidden', 'true');
    for (const color of entry.swatch) {
      const i = document.createElement('i');
      i.style.setProperty('--s', color);
      sw.appendChild(i);
    }

    const name = document.createElement('span');
    name.className = 'skin-name';
    name.textContent = entry.name;

    const note = document.createElement('span');
    note.className = 'skin-note';
    note.textContent = entry.note;

    const badge = document.createElement('span');
    badge.className = 'skin-badge';
    badge.textContent = entry.id === current ? 'Current' : '';

    b.append(sw, name, note, badge);
    b.onclick = () => onSkin(entry.id);
    root.appendChild(b);
  }
}

/**
 * Swap skins with a 160 ms chroma fade. The visualizer palette and speaker marks
 * follow in the same frame. Reduced motion makes it instant.
 */
export function applySkin(skin, { viz } = {}) {
  const s = normalizeSkin(skin);
  const html = document.documentElement;
  const m = html.dataset.themeMode === 'light' ? 'light' : 'dark';

  html.classList.add('skin-anim');
  clearTimeout(animTimer);
  void html.offsetWidth;
  html.dataset.skin = s;
  currentSkin = s;
  if (viz) vizRef = viz;
  if (vizRef) vizRef.applyThemePalette(skinPalette(s, m), m);
  animTimer = setTimeout(clearAnim, 180);
  return s;
}

/**
 * Swap dark / light with a 160 ms colour fade. The visualizer palette follows in
 * the same frame. Reduced motion makes it instant (the token durations are 0).
 */
export function applyMode(mode, { viz } = {}) {
  const m = mode === 'light' ? 'light' : 'dark';
  const html = document.documentElement;
  if (html.dataset.themeMode === m) return m;

  html.classList.add('mode-anim');
  clearTimeout(animTimer);
  // Commit the pre-swap colours with the transition rules active, then flip.
  void html.offsetWidth;
  html.dataset.theme = 'tech-moca';
  html.dataset.themeMode = m;
  if (viz) vizRef = viz;
  if (vizRef) vizRef.applyThemePalette(skinPalette(currentSkin, m), m);
  animTimer = setTimeout(clearAnim, 180);
  return m;
}

/** Boot-time application: no animation class, palette straight onto the viz. */
export function initTheme(mode, viz, skin) {
  const m = mode === 'light' ? 'light' : 'dark';
  const s = normalizeSkin(skin);
  const html = document.documentElement;
  html.dataset.theme = 'tech-moca';
  html.dataset.themeMode = m;
  html.dataset.skin = s;
  currentSkin = s;
  vizRef = viz || null;
  if (vizRef) vizRef.applyThemePalette(skinPalette(s, m), m);
  return m;
}
