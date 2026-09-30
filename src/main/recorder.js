'use strict';
/**
 * Recorder: turns the renderer's PCM firehose into chunk_0000.wav, chunk_0001.wav, ...
 * Chunk boundaries are sample-exact. Pause closes the current chunk, and resume
 * continues the same audio timeline with no silence added for the paused interval.
 */
const fs = require('fs');
const path = require('path');
const { WavWriter } = require('./wav');

class Recorder {
  constructor({ session, chunkSec, sampleRate = 48000, onChunkClosed }) {
    this.session = session;
    this.chunkSec = chunkSec;
    this.sampleRate = sampleRate;
    this.onChunkClosed = onChunkClosed;
    if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isFinite(chunkSec) || chunkSec <= 0) {
      throw new RangeError('Recorder requires a positive sample rate and chunk duration');
    }
    this.chunkBytes = Math.max(1, Math.round(chunkSec * sampleRate)) * 2;
    this.index = 0;
    this.writer = null;
    this.current = null;
    this.bytes = 0;
    this.active = false;
    this.paused = false;
    this.started = false;
    this.pendingByte = null;
  }

  start() {
    if (this.started) return false;
    this.started = true;
    this.active = true;
    return true;
  }

  pause() {
    if (!this.active || this.paused) return false;
    this.paused = true;
    // An incomplete PCM16 sample cannot be joined to audio from after a pause.
    this.pendingByte = null;
    this._closeChunk();
    return true;
  }

  resume() {
    if (!this.active || !this.paused) return false;
    this.paused = false;
    return true;
  }

  _openChunk() {
    const rel = `audio/chunk_${String(this.index).padStart(4, '0')}.wav`;
    const abs = path.join(this.session.folder, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });

    this.writer = new WavWriter(abs, { sampleRate: this.sampleRate, channels: 1, bitsPerSample: 16 }).open();
    this.rel = rel;
    this.abs = abs;

    const chunk = {
      index: this.index,
      offsetSec: this.recordedSeconds,
      durationSec: 0,
      audioFile: rel,
      transcriptFile: null,
      status: 'pending',
      error: null,
      attempts: 0,
      engine: null,
      words: [],
      text: '',
    };
    this.session.chunks.push(chunk);
    this.current = chunk;
  }

  /** @param {Buffer} buf  PCM16 mono at this.sampleRate */
  push(buf) {
    if (!this.active || this.paused || !buf || buf.length === 0) return;
    // Capture sends whole samples; tolerate a stream splitting one across buffers.
    if (this.pendingByte !== null) {
      buf = Buffer.concat([Buffer.from([this.pendingByte]), buf]);
      this.pendingByte = null;
    }
    if (buf.length % 2) {
      this.pendingByte = buf[buf.length - 1];
      buf = buf.subarray(0, -1);
    }
    let pos = 0;
    while (pos < buf.length) {
      if (!this.writer) this._openChunk();
      const take = Math.min(this.chunkBytes - this.writer.bytesWritten, buf.length - pos);
      this.writer.write(buf.subarray(pos, pos + take));
      this.bytes += take;
      pos += take;
      if (this.writer.bytesWritten === this.chunkBytes) this._closeChunk();
    }
  }

  _closeChunk() {
    if (!this.writer) return;
    const secs = this.writer.seconds;
    this.writer.close();
    this.current.durationSec = secs;
    const idx = this.current.index;
    this.writer = null;
    this.current = null;
    this.index += 1;
    if (this.onChunkClosed) this.onChunkClosed(idx);
  }

  stop() {
    if (!this.active) return false;
    this.active = false;
    this.paused = false;
    this.pendingByte = null;
    this._closeChunk();
    return true;
  }

  get recordedSeconds() {
    return this.bytes / (this.sampleRate * 2);
  }
}

module.exports = { Recorder };
