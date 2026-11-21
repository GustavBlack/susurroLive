#!/usr/bin/env node
'use strict';
/**
 * Builds the multi-size Windows icon from the raw artwork:
 *
 *   electron tools/make-icon.js [raw.png]
 *
 * Default raw art: C:/Users/Gusta/Downloads/susurroLive_Ico_rawArt.png
 * Writes assets/icon.ico (16..256), assets/_icon_256.png, assets/_icon_32_preview.png
 * and src/renderer/assets/icon-32.png (the header mark).
 *
 * The ICO is a PNG-in-ICO container: a 6-byte header, one 16-byte directory entry
 * per size, then the PNG payloads. Electron's nativeImage does the resampling.
 */
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const ROOT = path.join(__dirname, '..');
const RAW = process.argv[2] || 'C:/Users/Gusta/Downloads/susurroLive_Ico_rawArt.png';
const OUT_ICO = path.join(ROOT, 'assets', 'icon.ico');
const OUT_256 = path.join(ROOT, 'assets', '_icon_256.png');
const OUT_32 = path.join(ROOT, 'assets', '_icon_32_preview.png');
const OUT_MARK = path.join(ROOT, 'src', 'renderer', 'assets', 'icon-32.png');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(RAW);
  if (img.isEmpty()) {
    console.error(`could not read ${RAW}`);
    app.exit(1);
    return;
  }

  const entries = [];
  let offset = 6 + 16 * SIZES.length;
  for (const size of SIZES) {
    const png = img.resize({ width: size, height: size, quality: 'best' }).toPNG();
    entries.push({ size, png, offset });
    offset += png.length;
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(SIZES.length, 4);

  const dir = Buffer.alloc(16 * SIZES.length);
  entries.forEach((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size === 256 ? 0 : e.size, o);
    dir.writeUInt8(e.size === 256 ? 0 : e.size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(e.offset, o + 12);
  });

  fs.writeFileSync(OUT_ICO, Buffer.concat([header, dir, ...entries.map((e) => e.png)]));
  fs.writeFileSync(OUT_256, entries.find((e) => e.size === 256).png);
  fs.writeFileSync(OUT_32, entries.find((e) => e.size === 32).png);
  fs.mkdirSync(path.dirname(OUT_MARK), { recursive: true });
  fs.writeFileSync(OUT_MARK, entries.find((e) => e.size === 32).png);

  console.log(`wrote ${OUT_ICO} (${SIZES.join(', ')})`);
  console.log(`wrote ${OUT_256}`);
  console.log(`wrote ${OUT_32}`);
  console.log(`wrote ${OUT_MARK}`);
  app.quit();
});
