// susurroLive — Phase II colour skins (v1.9.0).
// A skin is a chroma-only layer over Tech Moca: the floor, lines, text, type,
// spacing, radius, shadow and motion stay locked. The archived theme palettes
// (theme/themes.js) are the colour source; this module derives the closed set of
// skin tokens and the canvas palette the visualizer needs.
//
// Generated CSS: theme/skins.css (tools/gen-skin-css.js). Contrast gate:
// tools/check-skins.js. Do not edit skins.css by hand.

import { THEMES } from './themes.js';
import { TECH_MOCA, hexRgb, mixHex, markColors } from './tech-moca.js';

// The house focus and warning colours are sand and warm amber in both modes.
// A skin never turns focus blue: blue is allowed only in accent, viz and marks.
const TM_FOCUS = { dark: '#b5a68c', light: '#6e6144' };
const TM_WARN = { dark: '#c9b07e', light: '#7a5f22' };

// ---------------------------------------------------------------- colour math
export function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function luminance(hex) {
  const [r, g, b] = hexRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function bestInk(accent) {
  const dark = '#141414';
  const light = '#f4f2ec';
  return contrast(dark, accent) >= contrast(light, accent) ? dark : light;
}

/** Mix toward the pole until `hex` reaches `min` contrast against `bg`. */
function ensureContrast(hex, bg, min, pole) {
  if (contrast(hex, bg) >= min) return hex;
  for (let k = 0.05; k <= 1.0001; k += 0.05) {
    const c = mixHex(hex, pole, k);
    if (contrast(c, bg) >= min) return c;
  }
  return pole;
}

// ---------------------------------------------------------------- skin derivation
function deriveSkin(theme, mode) {
  const p = theme[mode];
  const base = TECH_MOCA[mode];
  const bg = base.bg;
  const raised = base.surface2;
  const pole = mode === 'light' ? '#000000' : '#FFFFFF';
  const focus = TM_FOCUS[mode];
  let warn = TM_WARN[mode];

  // The accent is the primary pill fill. Choose the ink that reads on it, then
  // keep the fill above the 4.5:1 ink floor. The hover is a tint of the same hue.
  const accentInk = bestInk(p.accent);
  const accentPole = accentInk === '#141414' ? '#FFFFFF' : '#000000';
  const accent = ensureContrast(p.accent, accentInk, 4.5, accentPole);
  let accentStrong = ensureContrast(mixHex(accent, accentPole, 0.18), accentInk, 4.5, accentPole);
  accentStrong = ensureContrast(accentStrong, bg, 3.0, pole);
  accentStrong = ensureContrast(accentStrong, accentInk, 4.5, accentPole);

  // Status colours sit on their own wells. The well is a quiet tint of the
  // locked floor; the signal is adjusted, not the well, until the signal reads.
  let ok = p.success;
  let okBg = mixHex(bg, ok, 0.12);
  for (let i = 0; i < 3; i++) {
    ok = ensureContrast(ok, okBg, 4.5, pole);
    okBg = mixHex(bg, ok, 0.12);
  }
  let error = p.record;
  let errorBg = mixHex(bg, error, 0.12);
  for (let i = 0; i < 3; i++) {
    error = ensureContrast(error, errorBg, 4.5, pole);
    errorBg = mixHex(bg, error, 0.12);
  }
  const okLine = mixHex(bg, ok, 0.35);
  const errorLine = mixHex(bg, error, 0.35);
  const errorWash = mixHex(bg, error, 0.2);
  const errorStrong = ensureContrast(mixHex(error, pole, 0.15), accentInk, 4.5, accentPole);
  let warnBg = mixHex(bg, warn, 0.12);
  for (let i = 0; i < 3; i++) {
    warn = ensureContrast(warn, warnBg, 4.5, pole);
    warnBg = mixHex(bg, warn, 0.12);
  }
  const warnLine = mixHex(bg, warn, 0.35);

  // Chart series and speaker marks are the skin's visible colour story. They
  // must read on the raised surface; the adjuster lightens or darkens as needed.
  const viz = [
    accent,
    ok,
    error,
    mixHex(accent, ok, 0.5),
    p.borderAccent,
    mixHex(error, accent, 0.55),
  ].map((c) => ensureContrast(c, raised, 4.5, pole));
  const marks = [
    accent,
    ok,
    error,
    mixHex(accent, ok, 0.5),
    p.borderAccent,
    mixHex(error, accent, 0.55),
    p.textMut,
    base.text,
  ].map((c) => ensureContrast(c, raised, 4.5, pole));

  return {
    accent,
    accentStrong,
    accentInk,
    focus,
    ok,
    okBg,
    okLine,
    warn,
    warnBg,
    warnLine,
    error,
    errorBg,
    errorLine,
    errorStrong,
    errorWash,
    viz,
    marks,
  };
}

const SKIN_META = {
  default: { id: 'warm', name: 'Susurro Warm', note: 'Warm taupe, sand, clay' },
  obsidian: { id: 'obsidian', name: 'Obsidian', note: 'Neutral, zero hue' },
  midnight: { id: 'midnight', name: 'Midnight', note: 'Deep studio blue' },
  forest: { id: 'forest', name: 'Forest', note: 'Organic greens' },
  nord: { id: 'nord', name: 'Nord', note: 'Nordic minimal, ice blue' },
  amethyst: { id: 'amethyst', name: 'Amethyst', note: 'Soft purple haze' },
  crimson: { id: 'crimson', name: 'Crimson', note: 'Burnt reds, broadcast' },
  teal: { id: 'teal', name: 'Deep Teal', note: 'Aqua precision' },
  oled: { id: 'oled', name: 'True Black', note: 'Pure black, maximum contrast' },
  desert: { id: 'desert', name: 'Desert', note: 'Warm stone and sand' },
  tokyo: { id: 'tokyo', name: 'Tokyo Night', note: 'Blue-indigo, night-coded' },
};

export const SKINS = THEMES.map((theme) => {
  const meta = SKIN_META[theme.id];
  return {
    id: meta.id,
    name: meta.name,
    source: theme.name,
    note: meta.note,
    swatch: [theme.dark.accent, theme.dark.record, theme.dark.success],
    dark: deriveSkin(theme, 'dark'),
    light: deriveSkin(theme, 'light'),
  };
});

export const SKIN_IDS = SKINS.map((s) => s.id);
const SKIN_SET = new Set(SKIN_IDS);
const OLD_TO_SKIN = Object.fromEntries(THEMES.map((t) => [t.id, SKIN_META[t.id].id]));

/** Old `theme` values become skin ids; unknown values fall back to Tech Moca. */
export function normalizeSkin(id) {
  if (!id) return '';
  if (SKIN_SET.has(id)) return id;
  return OLD_TO_SKIN[id] || '';
}

export function getSkin(id) {
  const s = normalizeSkin(id);
  return s ? SKINS.find((x) => x.id === s) || null : null;
}

/** Tech Moca-shaped canvas palette for the visualizer, with the skin's marks. */
export function skinPalette(skin, mode) {
  const m = mode === 'light' ? 'light' : 'dark';
  const base = TECH_MOCA[m];
  const s = getSkin(skin);
  if (!s) return { ...base, marks: markColors(m) };
  const c = s[m];
  return {
    ...base,
    accent: c.accent,
    accentStrong: c.accentStrong,
    accentMuted: base.accentMuted,
    record: c.error,
    success: c.ok,
    borderAccent: c.focus,
    marks: c.marks,
  };
}

/** The chroma-only CSS custom properties for a skin and mode. */
export function skinCssTokens(skin, mode) {
  const s = getSkin(skin);
  if (!s) return null;
  const c = s[mode === 'light' ? 'light' : 'dark'];
  return {
    '--tm-accent': c.accent,
    '--tm-accent-strong': c.accentStrong,
    '--tm-accent-ink': c.accentInk,
    '--tm-focus': c.focus,
    '--tm-ok': c.ok,
    '--tm-ok-bg': c.okBg,
    '--tm-ok-line': c.okLine,
    '--tm-warn': c.warn,
    '--tm-warn-bg': c.warnBg,
    '--tm-warn-line': c.warnLine,
    '--tm-error': c.error,
    '--tm-error-bg': c.errorBg,
    '--tm-error-line': c.errorLine,
    '--tm-error-strong': c.errorStrong,
    '--tm-viz-1': c.viz[0],
    '--tm-viz-2': c.viz[1],
    '--tm-viz-3': c.viz[2],
    '--tm-viz-4': c.viz[3],
    '--tm-viz-5': c.viz[4],
    '--tm-viz-6': c.viz[5],
    '--tm-viz-other': 'var(--tm-text-faint)',
    '--tm-mark-sand': c.marks[0],
    '--tm-mark-sage': c.marks[1],
    '--tm-mark-brick': c.marks[2],
    '--tm-mark-slate': c.marks[3],
    '--tm-mark-clay': c.marks[4],
    '--tm-mark-heather': c.marks[5],
    '--tm-mark-stone': c.marks[6],
  };
}
