#!/usr/bin/env node
'use strict';
/**
 * Release artifact gate — every `npm run dist` MUST produce:
 *   build/latest.yml                              (update-feed metadata)
 *   build/latest.yml.blockmap                     (differential updates)
 *   build/susurroLive-Setup-<version>.exe         (NSIS installer, PRIMARY)
 *   build/susurroLive-<version>-portable.exe      (portable, SECONDARY)
 * with latest.yml's version === package.json's version, and the installer above a sane size
 * floor (a silent NSIS truncation must never ship as an update).
 *
 * Wired into `npm run dist`. Exits 1 with clear messages on any violation.
 */
const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '..', 'build');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const v = pkg.version;

let failed = 0;
const problems = [];
function requireFile(rel, { minBytes = 0 } = {}) {
  const p = path.join(buildDir, rel);
  if (!fs.existsSync(p)) { problems.push(`missing: ${rel}`); failed++; return; }
  const bytes = fs.statSync(p).size;
  if (bytes < minBytes) {
    problems.push(`too small: ${rel} (${(bytes / 1e9).toFixed(2)} GB < ${(minBytes / 1e9).toFixed(2)} GB floor)`);
    failed++;
  }
}

requireFile(`latest.yml`);
requireFile(`susurroLive-Setup-${v}.exe.blockmap`);        // differential-update map (named after the installer)
requireFile(`susurroLive-Setup-${v}.exe`, { minBytes: 1.0e9 });
requireFile(`susurroLive-${v}-portable.exe`, { minBytes: 1.0e9 });

// latest.yml must advertise THIS version (stale metadata breaks/rolls back updates)
try {
  const yml = fs.readFileSync(path.join(buildDir, 'latest.yml'), 'utf8');
  const m = yml.match(/^version:\s*(.+)$/m);
  if (!m || m[1].trim() !== v) {
    problems.push(`latest.yml version ${m ? m[1].trim() : '?'} != package.json ${v}`);
    failed++;
  }
} catch { /* already reported missing */ }

if (failed) {
  console.error(`RELEASE GATE FAILED (${failed}):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('Do NOT publish this build. Re-run `npm run dist` and investigate.');
  process.exit(1);
}
console.log(`release gate: OK — v${v} ships installer + portable + update feed (latest.yml + blockmap)`);
