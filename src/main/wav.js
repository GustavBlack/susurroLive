'use strict';
/**
 * Minimal WAV (16-bit PCM) reader/writer/concatenator.
 * No dependencies. Everything in susurroLive is 48 kHz PCM16.
 */
const fs = require('fs');

const HEADER_BYTES = 44;

function makeHeader({ sampleRate, channels, bitsPerSample, dataBytes }) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const b = Buffer.alloc(HEADER_BYTES);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bitsPerSample, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

function readHeader(path) {
  const fd = fs.openSync(path, 'r');
  try {
    const b = Buffer.alloc(HEADER_BYTES);
    fs.readSync(fd, b, 0, HEADER_BYTES, 0);
    return {
      riff: b.toString('ascii', 0, 4),
      wave: b.toString('ascii', 8, 12),
      fmt: b.toString('ascii', 12, 16),
      channels: b.readUInt16LE(22),
      sampleRate: b.readUInt32LE(24),
      bitsPerSample: b.readUInt16LE(34),
      dataBytes: b.readUInt32LE(40),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** Streaming writer: header patched with real sizes on close(). */
class WavWriter {
  constructor(filePath, { sampleRate = 48000, channels = 1, bitsPerSample = 16 } = {}) {
    this.path = filePath;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bitsPerSample = bitsPerSample;
    this.bytesWritten = 0;
    this.fd = null;
  }

  open() {
    this.fd = fs.openSync(this.path, 'w');
    fs.writeSync(this.fd, makeHeader({
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitsPerSample: this.bitsPerSample,
      dataBytes: 0,
    }));
    return this;
  }

  /** @param {Buffer} pcm  raw little-endian PCM16 */
  write(pcm) {
    if (!this.fd || !pcm || pcm.length === 0) return;
    fs.writeSync(this.fd, pcm);
    this.bytesWritten += pcm.length;
  }

  get seconds() {
    const blockAlign = (this.channels * this.bitsPerSample) / 8;
    return this.bytesWritten / (blockAlign * this.sampleRate);
  }

  close() {
    if (!this.fd) return this.path;
    // patch sizes
    fs.writeSync(this.fd, makeHeader({
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitsPerSample: this.bitsPerSample,
      dataBytes: this.bytesWritten,
    }), 0, HEADER_BYTES, 0);
    fs.closeSync(this.fd);
    this.fd = null;
    return this.path;
  }
}

/** Concatenate N same-format wav files into one. Returns {path, seconds}. */
function concatWavs(paths, outPath) {
  const existing = paths.filter((p) => fs.existsSync(p));
  if (existing.length === 0) return null;

  const first = readHeader(existing[0]);
  const total = existing.reduce((n, p) => n + fs.statSync(p).size - HEADER_BYTES, 0);

  const fd = fs.openSync(outPath, 'w');
  try {
    fs.writeSync(fd, makeHeader({
      sampleRate: first.sampleRate,
      channels: first.channels,
      bitsPerSample: first.bitsPerSample,
      dataBytes: total,
    }));
    const buf = Buffer.alloc(1 << 20);
    for (const p of existing) {
      const f = fs.openSync(p, 'r');
      try {
        let pos = HEADER_BYTES;
        const end = fs.statSync(p).size;
        while (pos < end) {
          const n = fs.readSync(f, buf, 0, Math.min(buf.length, end - pos), pos);
          if (n <= 0) break;
          fs.writeSync(fd, buf, 0, n);
          pos += n;
        }
      } finally {
        fs.closeSync(f);
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  const blockAlign = (first.channels * first.bitsPerSample) / 8;
  return { path: outPath, seconds: total / (blockAlign * first.sampleRate) };
}

module.exports = { WavWriter, concatWavs, readHeader, makeHeader, HEADER_BYTES };
