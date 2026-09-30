'use strict';
/**
 * FFmpeg bridge: locate the binary and decode ANY media file (mp3, mp4, mkv, m4a, ...)
 * into raw PCM16 mono 48 kHz - the app's one canonical audio format.
 *
 * Decode is STREAMING: ffmpeg's stdout is piped straight into the Recorder, so imported
 * media passes through the exact same byte-exact chunking as live capture. No giant
 * intermediate file, no copy of the audio.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TARGET = { sampleRate: 48000, channels: 1, bitsPerSample: 16 };

/** Candidate locations, first existing wins. */
function searchPaths(repoRoot, binDir) {
  return [
    binDir ? path.join(binDir, 'ffmpeg.exe') : '',        // packaged: resources/bin
    path.join(repoRoot, 'native', 'bin', 'ffmpeg.exe'),   // dev repo layout
    process.env.SUSURRO_FFMPEG || '',                     // explicit override
    'C:/FFmpeg/bin/ffmpeg.exe',                           // this machine's install
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  ];
}

let cached = null;
function findFfmpeg(repoRoot, binDir) {
  if (cached) return cached;
  for (const p of searchPaths(repoRoot, binDir)) {
    if (p && fs.existsSync(p)) { cached = p; return p; }
  }
  try {
    const out = execFileSync('where', ['ffmpeg'], { encoding: 'utf8', timeout: 5000 });
    const first = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) { cached = first; return first; }
  } catch { /* not on PATH */ }
  cached = '';
  return cached;
}

/** Media extensions we accept in the import dialog. */
const MEDIA_EXTS = new Set([
  // audio
  'wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aiff', 'aif', 'amr',
  // video (audio is extracted)
  'mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'ts', 'm4v', 'mpg', 'mpeg', '3gp',
]);

/** Probe duration (seconds) + container/format info via ffprobe, next to ffmpeg. */
function probe(mediaPath, ffmpegPath) {
  const ffprobe = path.join(path.dirname(ffmpegPath), 'ffprobe.exe');
  if (!fs.existsSync(ffprobe)) return { durationSec: null, format: null };
  try {
    const out = execFileSync(ffprobe, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', mediaPath,
    ], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 << 20 });
    const doc = JSON.parse(out);
    const dur = Number(doc?.format?.duration);
    return {
      durationSec: Number.isFinite(dur) ? dur : null,
      format: doc?.format?.format_name || null,
    };
  } catch {
    return { durationSec: null, format: null };
  }
}

/**
 * Stream-decode `mediaPath` into PCM16 mono 48k, handing every byte chunk to `onData`.
 * Resolves with { seconds } when ffmpeg finishes. Rejects on nonzero exit.
 *
 * - `-vn` drops video: we never decode a single video frame.
 * `-ac 1 -ar 48000` forces the canonical format regardless of input.
 * `-af aresample=resampler=soxr` is NOT used: keep defaults so behaviour matches
 *  whisper.cpp's own resampling expectations.
 */
function decodeToPcm(ffmpegPath, mediaPath, onData, { onSpawned } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', mediaPath,
      '-vn',                 // no video decode
      '-ac', String(TARGET.channels),
      '-ar', String(TARGET.sampleRate),
      '-f', 's16le',         // raw PCM16 little-endian
      '-',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    if (onSpawned) onSpawned(child);

    child.stdout.on('data', (buf) => {
      try { onData(buf); } catch (e) {
        done(reject, e);
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (e) => done(reject, new Error(`cannot start ffmpeg: ${e.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      if (code === 0) done(resolve, { ok: true });
      else done(reject, new Error(`ffmpeg exited ${code}: ${stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')}`));
    });
  });
}

/** Human list of accepted extensions for dialogs. */
function mediaFilterName() {
  return { name: 'Media (audio & video)', extensions: [...MEDIA_EXTS] };
}

module.exports = { findFfmpeg, probe, decodeToPcm, MEDIA_EXTS, mediaFilterName, TARGET };
