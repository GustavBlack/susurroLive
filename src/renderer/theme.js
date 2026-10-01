// theme.js — v1.5 theme engine (renderer side).
// Applies <html data-theme data-theme-mode>, runs the 667 ms staggered swap
// (chrome surfaces lead, content follows — see style.css "theme swap"), and
// retunes the canvas visualizer palette in the same frame.

import { THEMES, getTheme, DEFAULT_THEME } from './theme/themes.js';

let vizRef = null;
let animTimer = null;

/** Paint the theme picker swatches (bg | accent | text strip of the active mode). */
export function renderThemePicker(root, { theme, themeMode, onPick, onMode }) {
  root.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'theme-grid';

  for (const t of THEMES) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'theme-opt' + (t.id === theme ? ' on' : '');
    opt.title = t.desc;
    opt.dataset.id = t.id;

    const sw = document.createElement('span');
    sw.className = 'sw';
    const pal = t[themeMode] || t.dark;
    for (const c of [pal.bg, pal.accent, pal.text]) {
      const i = document.createElement('i');
      i.style.background = c;
      sw.appendChild(i);
    }
    const meta = document.createElement('span');
    meta.className = 'meta';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = t.name;
    const vb = document.createElement('span');
    vb.className = 'vb';
    vb.textContent = t.vibe;
    meta.append(nm, vb);

    opt.append(sw, meta);
    opt.onclick = () => onPick(t.id);
    grid.appendChild(opt);
  }
  root.appendChild(grid);

  // dark / light segmentation — per theme, persisted alongside the theme id
  const seg = document.createElement('div');
  seg.className = 'seg';
  for (const m of ['dark', 'light']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm' + (m === themeMode ? ' on' : '');
    b.textContent = m === 'dark' ? 'Dark' : 'Light';
    b.onclick = () => onMode(m);
    seg.appendChild(b);
  }
  root.appendChild(seg);
}

/**
 * Swap the active theme with the staged transition:
 *   frame 0   set html.theme-anim  (chrome transitions start at 0 ms)
 *   frame 1   flip data-theme/-mode + retune the viz palette (tokens recompute,
 *             chrome surfaces start blending; content has a 111 ms delay)
 *   +780 ms   drop html.theme-anim (content transitions finish at 778 ms)
 */
export function applyTheme(themeId, mode, { viz } = {}) {
  const id = getTheme(themeId)?.id || DEFAULT_THEME;
  const m = mode === 'light' ? 'light' : 'dark';
  const html = document.documentElement;
  const next = `${id}|${m}`;
  if (html.dataset.theme === id && html.dataset.themeMode === m) return next;

  html.classList.add('theme-anim');
  clearTimeout(animTimer);

  // Force a synchronous style recalc so the pre-swap colors are committed WITH the
  // transition rules active; the token flip below then animates. rAF is unusable
  // here: hidden windows never fire it, which would freeze the swap mid-flight.
  void html.offsetWidth;
  html.dataset.theme = id;
  html.dataset.themeMode = m;
  if (viz) vizRef = viz;
  if (vizRef) vizRef.applyThemePalette(getTheme(id), m);
  animTimer = setTimeout(() => html.classList.remove('theme-anim'), 780);
  return next;
}

/** Boot-time application: no animation class, palette straight onto the viz. */
export function initTheme(themeId, mode, viz) {
  const id = getTheme(themeId)?.id || DEFAULT_THEME;
  const m = mode === 'light' ? 'light' : 'dark';
  const html = document.documentElement;
  html.dataset.theme = id;
  html.dataset.themeMode = m;
  vizRef = viz || null;
  if (vizRef) vizRef.applyThemePalette(getTheme(id), m);
  return `${id}|${m}`;
}
