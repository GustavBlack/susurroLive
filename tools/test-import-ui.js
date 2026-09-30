'use strict';
/**
 * E2E check of the chunk-strip completion bug: import a real media file through the
 * RUNNING APP (electron, real pipeline), drive the import via the renderer bridge, and
 * assert the UI counts every chunk done (the regression was: stuck at 0/N).
 *
 * Run: node tools/test-import-ui.js
 * Requires: engine available (real whisper) — reuses the built-in small.en model.
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const repo = path.join(__dirname, '..');
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function synthWav(out, seconds, sampleRate = 48000) {
  const { WavWriter } = require('../src/main/wav');
  const w = new WavWriter(out, { sampleRate, channels: 1, bitsPerSample: 16 }).open();
  const half = Buffer.alloc(sampleRate);
  for (let i = 0; i < half.length; i += 2) half.writeInt16LE(Math.round(8000 * Math.sin(i / 20)), i);
  let remaining = seconds;
  while (remaining >= 0.5) { w.write(half); remaining -= 0.5; }
  if (remaining > 0) w.write(Buffer.alloc(Math.round(remaining * sampleRate * 2)));
  w.close();
  return out;
}

async function main() {
  const ff = require('../src/main/ffmpeg').findFfmpeg(repo);
  if (!ff) { console.error('ffmpeg not found'); process.exit(1); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-ui-'));
  const sessionsDir = path.join(tmp, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  // Real speech (whisper.cpp's jfk sample), padded with tone to push it past one chunk
  // boundary so the strip has >1 chip to finish. 16k mono source -> ffmpeg resamples.
  const jfk = path.join(repo, 'native', 'src', 'whisper.cpp', 'samples', 'jfk.wav');
  const padded = path.join(tmp, 'speech.wav');
  const pad = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-i', jfk, '-af', 'apad=pad_dur=70', '-ar', '48000', '-ac', '1', '-y', padded], { encoding: 'utf8' });
  if (pad.status !== 0) { console.error('pad failed:', pad.stderr); process.exit(1); }
  const mp4 = path.join(tmp, 'speech.mp4');
  
  const mux = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-i', padded, '-c:a', 'aac', '-y', mp4], { encoding: 'utf8' });
  if (mux.status !== 0) { console.error('mux failed:', mux.stderr); process.exit(1); }

  console.log('media:', mp4);

  // Boot the real app pointed at our temp sessions dir, then drive it via executeJavaScript.
  const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
  const electron = spawn(electronBin, ['.', '--smoke-import'], {
    cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env,
      SUSURRO_IMPORT_PARENT: sessionsDir,
      SUSURRO_IMPORT_FILE: mp4,
    },
  });
  let out = '';
  electron.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d); });
  electron.stderr.on('data', (d) => { process.stderr.write(d); });

  const code = await new Promise((res) => electron.on('close', res));

  // The app's smoke-import routine prints the verdict; parse it.
  const m = out.match(/IMPORT-UI-RESULT: (\{.*\})/);
  if (!m) {
    console.error('\nno IMPORT-UI-RESULT line — smoke-import hook missing or app crashed');
    process.exit(1);
  }
  const r = JSON.parse(m[1]);
  check('import succeeded', r.importOk === true, r.error);
  check('chunks created > 0', r.chunks > 0, String(r.chunks));
  check('UI strip shows ALL chunks done', r.uiDone === r.chunks, `uiDone=${r.uiDone} / chunks=${r.chunks}`);
  check('pipeStatus text agrees', String(r.pipeText || '').includes(`${r.chunks}/${r.chunks} done`), r.pipeText);
  check('retry button hidden (no failures)', r.retryHidden === true, String(r.retryHidden));
  check('retry hidden on fresh boot (no session)', r.bootRetryHidden === true, String(r.bootRetryHidden));
  check('retry hidden after session close', r.cleanRetryHidden === true, String(r.cleanRetryHidden));
  check('transcript has words', r.words > 0, String(r.words));

  console.log(`\n${failures ? 'FAILED' : 'ALL PASSED'} (${failures} failures)`);
  process.exitCode = failures ? 1 : 0;
  process.exit(process.exitCode);
  void code;
}

main().catch((e) => { console.error(e); process.exit(1); });
