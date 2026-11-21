#!/usr/bin/env node
'use strict';
/**
 * Contrast gate for Phase II skins. Fails when a skin's accent, focus, status,
 * chart or speaker colour drops below the Tech Moca house floors in either mode.
 *
 *   node tools/check-skins.js
 *
 * Floors: ink on a signal fill 4.5:1; focus and status text on their wells 4.5:1;
 * chart and speaker marks on the raised surface 4.5:1; accent and hover fill on
 * the floor 3:1; the muted "other" series 3:1.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');

async function main() {
  const { SKINS, contrast } = await import(
    'file:///' + path.join(ROOT, 'src', 'renderer', 'theme', 'skins.js').replace(/\\/g, '/')
  );
  const { TECH_MOCA } = await import(
    'file:///' + path.join(ROOT, 'src', 'renderer', 'theme', 'tech-moca.js').replace(/\\/g, '/')
  );

  let failed = 0;
  let checked = 0;

  for (const skin of SKINS) {
    for (const mode of ['dark', 'light']) {
      const c = skin[mode];
      const base = TECH_MOCA[mode];
      const rows = [
        ['accent ink on accent', c.accentInk, c.accent, 4.5],
        ['accent ink on accent hover', c.accentInk, c.accentStrong, 4.5],
        ['accent ink on focus', c.accentInk, c.focus, 3.0],
        ['accent ink on error hover', c.accentInk, c.errorStrong, 4.5],
        ['accent on floor', c.accent, base.bg, 3.0],
        ['accent hover on floor', c.accentStrong, base.bg, 3.0],
        ['focus on floor', c.focus, base.bg, 4.5],
        ['ok on ok well', c.ok, c.okBg, 4.5],
        ['warn on warn well', c.warn, c.warnBg, 4.5],
        ['error on error well', c.error, c.errorBg, 4.5],
        ['other series on raised', base.textMut, base.surface2, 3.0],
      ];
      c.viz.forEach((v, i) => rows.push([`viz-${i + 1} on raised`, v, base.surface2, 4.5]));
      c.marks.forEach((v, i) => rows.push([`mark-${i + 1} on raised`, v, base.surface2, 4.5]));

      let min = Infinity;
      for (const [label, fg, bg, floor] of rows) {
        const ratio = contrast(fg, bg);
        checked++;
        if (ratio < min) min = ratio;
        if (ratio < floor) {
          failed++;
          console.error(
            `FAIL ${skin.id}/${mode} ${label}: ${ratio.toFixed(2)}:1 (floor ${floor.toFixed(1)}:1)`,
          );
        }
      }
      console.log(`${skin.id}/${mode}: ${rows.length} checks, min ${min.toFixed(2)}:1`);
    }
  }

  console.log(`\n${checked} contrast checks, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
