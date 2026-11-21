// susurroLive — Tech Moca canvas palette (v1.8.0; base for v1.9.0 skins).
// The DOM palette lives in tech-moca.css. This module is the same palette in the
// shape the visualizer needs, plus the eight session marks used for speaker labels.
// v1.9.0: theme/skins.js derives a skin palette in this shape; viz.js accepts it.
// Self-contained: no imports, so tools/test-viz.js can bundle it with viz.js.

export const TECH_MOCA = {
  dark: {
    bg: '#141414',
    surface: '#1b1b1b',
    surface2: '#1b1b1b',
    border: '#2c2c2c',
    borderAccent: '#5f5c57',
    text: '#e6e3de',
    textSec: '#9b978f',
    textMut: '#6f6b64',
    accent: '#b5a68c',
    accentStrong: '#d0c080',
    accentMuted: '#262626',
    record: '#c9827a',
    success: '#8db592',
  },
  light: {
    bg: '#ece9e2',
    surface: '#f4f2ec',
    surface2: '#f4f2ec',
    border: '#c6c1b5',
    borderAccent: '#a8a295',
    text: '#201f1b',
    textSec: '#55524c',
    textMut: '#837f77',
    accent: '#6e6144',
    accentStrong: '#776428',
    accentMuted: '#dedad1',
    record: '#984a42',
    success: '#3f6b47',
  },
};

// The eight session marks (STYLE-GUIDE §3.11), in the brief's dark hex values.
// Light values are the same hues at the light-mode lightness from tokens.css.
export const TM_MARKS = {
  dark: ['#d0c080', '#8bc25b', '#cc6966', '#5db699', '#d9894a', '#b988ce', '#d68fae', '#e6e3de'],
  light: ['#776428', '#46722c', '#99333a', '#256554', '#9c5220', '#793f92', '#a43d69', '#201f1b'],
};

// ---------------------------------------------------------------- colour math
export const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** sRGB lerp: mix(a, b, k) with k=0 -> a, k=1 -> b. */
export function mixHex(a, b, k) {
  const A = hexRgb(a), B = hexRgb(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * k).toString(16).padStart(2, '0')).join('');
}

export function getTechMoca(mode) {
  return mode === 'light' ? TECH_MOCA.light : TECH_MOCA.dark;
}

export function markColors(mode) {
  return mode === 'light' ? TM_MARKS.light : TM_MARKS.dark;
}
