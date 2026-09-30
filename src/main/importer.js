'use strict';
/**
 * Import: turn an arbitrary media file (audio OR video) into a regular susurroLive
 * session. The media is stream-decoded by ffmpeg into PCM16 mono 48k and fed through
 * the SAME Recorder used for live capture, so chunking, offsets, the pipeline, karaoke
 * sync, exports and session reopen all work unchanged.
 *
 * One timeline invariant matters here: for live capture the Recorder closes chunks at
 * exactly `chunkSec` (byte-exact), and `offsetSec = index * chunkSec`. A decoded file is
 * NOT guaranteed to be a whole number of chunks long, so the import RE-DERIVES each
 * chunk's offsetSec from the byte counts after decode completes. During the streaming
 * decode all chunks except the last are exactly chunkSec, so the derivation matches the
 * recording formula for every boundary chunk and only fixes the tail.
 */

const path = require('path');
const { Recorder } = require('./recorder');
const ffmpeg = require('./ffmpeg');

/** Derive offsetSec from the chunk's own byte length instead of index * chunkSec. */
function rederiveOffsets(session, chunkSec, sampleRate) {
  const bytesPerSec = sampleRate * 2; // PCM16 mono
  for (const c of session.chunks) {
    const abs = path.join(session.folder, c.audioFile);
    try {
      const size = require('fs').statSync(abs).size;
      const dataBytes = Math.max(0, size - 44); // canonical 44-byte header written by WavWriter
      c.durationSec = Number((dataBytes / bytesPerSec).toFixed(3));
      c.offsetSec = Number(
        session.chunks
          .slice(0, session.chunks.indexOf(c))
          .reduce((n, p) => n + p.durationSec, 0).toFixed(3),
      );
    } catch { /* missing file: keep previous values */ }
  }
  session.recording.durationSec = Number(
    session.chunks.reduce((n, c) => n + c.durationSec, 0).toFixed(2),
  );
  void chunkSec;
}

/**
 * @param {object} deps
 * @param {object} deps.ffmpegPath  resolved ffmpeg binary path (may be '' -> caller checked)
 * @param {(evt:string, payload:any) => void} deps.emit
 * @returns {Promise<{ok:boolean, error?:string, session?:object, seconds?:number}>}
 */
async function importMedia({ ffmpegPath, session, mediaPath, chunkSec, onProgress, onPersist }) {
  if (!ffmpegPath) {
    return { ok: false, error: 'ffmpeg not found - put ffmpeg.exe in native/bin or on PATH' };
  }

  const probe = ffmpeg.probe(mediaPath, ffmpegPath);
  session.import = {
    sourceFile: String(mediaPath),
    sourceName: path.basename(mediaPath),
    format: probe.format,
    sourceDurationSec: probe.durationSec,
    importedAt: new Date().toISOString(),
  };
  session.recording.sampleRate = ffmpeg.TARGET.sampleRate;
  session.recording.channels = ffmpeg.TARGET.channels;
  session.recording.chunkSec = chunkSec;
  if (probe.durationSec) session.recording.durationSec = Number(probe.durationSec.toFixed(2));

  const recorder = new Recorder({
    session,
    chunkSec,
    sampleRate: ffmpeg.TARGET.sampleRate,
    onChunkClosed: () => {
      if (onPersist) onPersist();
      emitChunkList(session, session.chunks[session.chunks.length - 1]?.index ?? 0, onProgress);
    },
  });

  const bytesPerSec = ffmpeg.TARGET.sampleRate * 2;
  const chunkBytes = chunkSec * bytesPerSec;
  let bytesIn = 0;
  recorder.start();

  /**
   * Push without ever crossing a chunk boundary. ffmpeg's stdout arrives in ~64 KB
   * blocks; Recorder closes a chunk after writing the whole buffer, so an unsliced
   * block straddling 5.000s would glue the next chunk's opening bytes onto this
   * chunk's tail and corrupt the seam. Slicing keeps import boundaries byte-exact.
   */
  const pushSliced = (buf) => {
    let pos = 0;
    while (pos < buf.length) {
      const written = bytesIn % chunkBytes;
      const room = chunkBytes - written;
      const take = Math.min(room, buf.length - pos);
      recorder.push(buf.subarray(pos, pos + take));
      bytesIn += take;
      pos += take;
    }
  };

  try {
    await ffmpeg.decodeToPcm(ffmpegPath, mediaPath, (buf) => {
      pushSliced(buf);
      if (probe.durationSec && onProgress) {
        onProgress('import', {
          phase: 'decoding',
          seconds: Number((bytesIn / bytesPerSec).toFixed(1)),
          total: Number(probe.durationSec.toFixed(1)),
          pct: Math.min(0.99, bytesIn / bytesPerSec / probe.durationSec),
        });
      }
    });
  } catch (err) {
    try { recorder.stop(); } catch { /* already failed */ }
    return { ok: false, error: String(err.message || err) };
  }

  recorder.stop();
  rederiveOffsets(session, chunkSec, ffmpeg.TARGET.sampleRate);

  if (probe.durationSec && onProgress) {
    onProgress('import', { phase: 'done', seconds: session.recording.durationSec, total: session.recording.durationSec, pct: 1 });
  }
  if (onPersist) onPersist();
  return { ok: true, session, seconds: session.recording.durationSec, chunks: session.chunks.length };
}

function emitChunkList(session, idx, onProgress) {
  if (!onProgress) return;
  onProgress('chunks', session.chunks.map((c) => ({
    index: c.index, status: c.status, durationSec: c.durationSec,
  })));
  if (idx >= 0) onProgress('chunk', { index: idx, status: 'pending' });
}

module.exports = { importMedia, rederiveOffsets };
