'use strict';
// node tools/test-recorder.js — sample-exact recording, pause/resume, and WAV export.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Recorder } = require('../src/main/recorder');
const { concatWavs, readHeader, HEADER_BYTES } = require('../src/main/wav');

function fixture(t, options = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-recorder-'));
  const session = { folder, chunks: [] };
  const closed = [];
  const recorder = new Recorder({
    session, chunkSec: 1, sampleRate: 10, ...options,
    onChunkClosed: (index) => {
      const chunk = session.chunks[index];
      const abs = path.join(folder, chunk.audioFile);
      // The callback can immediately read or transcribe a complete WAV.
      const header = readHeader(abs);
      assert.equal(header.dataBytes, fs.statSync(abs).size - HEADER_BYTES);
      assert.equal(chunk.durationSec, header.dataBytes / (recorder.sampleRate * 2));
      assert.equal(recorder.writer, null);
      closed.push(index);
    },
  });
  t.after(() => {
    recorder.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const pcm = () => Buffer.concat(session.chunks.map((c) =>
    fs.readFileSync(path.join(folder, c.audioFile)).subarray(HEADER_BYTES)));
  return { folder, session, closed, recorder, pcm };
}

test('buffers crossing multiple boundaries preserve every sample in exact chunks', (t) => {
  const { session, closed, recorder, pcm } = fixture(t);
  const input = Buffer.from(Array.from({ length: 66 }, (_, i) => i));
  recorder.start();
  recorder.push(input.subarray(0, 14));
  recorder.push(input.subarray(14));
  assert.equal(recorder.recordedSeconds, 3.3);
  recorder.stop();
  assert.deepEqual(session.chunks.map((c) => c.durationSec), [1, 1, 1, 0.3]);
  assert.deepEqual(session.chunks.map((c) => c.offsetSec), [0, 1, 2, 3]);
  assert.deepEqual(closed, [0, 1, 2, 3]);
  assert.deepEqual(pcm(), input);
});

test('pause finalizes audio, drops paused PCM, and resumes a continuous exported timeline', (t) => {
  const { folder, session, closed, recorder, pcm } = fixture(t);
  const before = Buffer.alloc(26, 1);
  const after = Buffer.alloc(24, 3);
  recorder.start();
  recorder.push(before);
  assert.equal(recorder.pause(), true);
  assert.equal(recorder.paused, true);
  assert.equal(recorder.active, true);
  assert.equal(recorder.writer, null);
  assert.deepEqual(closed, [0, 1]);
  recorder.push(Buffer.alloc(200, 2));
  assert.equal(recorder.recordedSeconds, 1.3);
  assert.equal(recorder.pause(), false);
  assert.equal(recorder.resume(), true);
  assert.equal(recorder.resume(), false);
  assert.equal(recorder.writer, null);
  recorder.push(after);
  recorder.stop();
  assert.equal(recorder.recordedSeconds, 2.5);
  assert.deepEqual(session.chunks.map((c) => c.durationSec), [1, 0.3, 1, 0.2]);
  assert.deepEqual(session.chunks.map((c) => c.offsetSec), [0, 1, 1.3, 2.3]);
  assert.deepEqual(closed, [0, 1, 2, 3]);
  assert.deepEqual(pcm(), Buffer.concat([before, after]));
  const output = path.join(folder, 'full.wav');
  const exported = concatWavs(session.chunks.map((c) => path.join(folder, c.audioFile)), output);
  assert.equal(exported.seconds, 2.5);
  assert.equal(readHeader(output).dataBytes, 50);
  assert.deepEqual(fs.readFileSync(output).subarray(HEADER_BYTES), Buffer.concat([before, after]));
});

test('stop while paused and repeated controls do not duplicate chunks or reopen writers', (t) => {
  const { folder, session, closed, recorder } = fixture(t);
  assert.equal(recorder.pause(), false);
  assert.equal(recorder.resume(), false);
  assert.equal(recorder.stop(), false);
  recorder.push(Buffer.alloc(20));
  assert.equal(recorder.start(), true);
  recorder.push(Buffer.alloc(6));
  assert.equal(recorder.start(), false);
  recorder.pause();
  assert.equal(recorder.stop(), true);
  assert.equal(recorder.stop(), false);
  assert.equal(recorder.resume(), false);
  assert.equal(recorder.pause(), false);
  recorder.push(Buffer.alloc(40));
  assert.equal(recorder.recordedSeconds, 0.3);
  assert.equal(recorder.active, false);
  assert.equal(recorder.paused, false);
  assert.equal(recorder.writer, null);
  assert.equal(recorder.current, null);
  assert.deepEqual(closed, [0]);
  assert.equal(session.chunks.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(folder, 'audio')), ['chunk_0000.wav']);
});

test('empty recordings and exact-boundary pauses produce no empty WAV or file handle', (t) => {
  const empty = fixture(t);
  empty.recorder.start();
  empty.recorder.pause();
  empty.recorder.resume();
  empty.recorder.stop();
  assert.deepEqual(empty.session.chunks, []);
  assert.deepEqual(empty.closed, []);
  assert.equal(fs.existsSync(path.join(empty.folder, 'audio')), false);
  const exact = fixture(t);
  exact.recorder.start();
  exact.recorder.push(Buffer.alloc(40));
  assert.equal(exact.recorder.writer, null);
  exact.recorder.pause();
  exact.recorder.stop();
  assert.deepEqual(exact.closed, [0, 1]);
  assert.equal(exact.session.chunks.length, 2);
  assert.equal(exact.recorder.recordedSeconds, 2);
});

test('sub-millisecond audio survives pause without rounded offsets or drift', (t) => {
  const { session, recorder, pcm } = fixture(t, { sampleRate: 48000 });
  recorder.start();
  for (let i = 0; i < 12; i++) {
    recorder.push(Buffer.from([i, 0]));
    recorder.pause();
    assert.equal(session.chunks[i].offsetSec, i / 48000);
    assert.equal(session.chunks[i].durationSec, 1 / 48000);
    recorder.resume();
  }
  recorder.stop();
  assert.equal(recorder.recordedSeconds, 12 / 48000);
  assert.equal(pcm().length, 24);
});

test('odd-sized stream buffers are reassembled into aligned PCM16 samples', (t) => {
  const { session, recorder, pcm } = fixture(t);
  const input = Buffer.from(Array.from({ length: 48 }, (_, i) => i));
  recorder.start();
  for (let i = 0; i < input.length; i += 3) recorder.push(input.subarray(i, i + 3));
  recorder.stop();
  assert.deepEqual(pcm(), input);
  assert.deepEqual(session.chunks.map((c) => c.durationSec), [1, 1, 0.4]);
  assert.equal(recorder.recordedSeconds, 2.4);
});

test('an incomplete sample is not joined across a pause', (t) => {
  const { recorder, pcm } = fixture(t);
  recorder.start();
  recorder.push(Buffer.from([1, 0, 255]));
  recorder.pause();
  recorder.resume();
  recorder.push(Buffer.from([2, 0]));
  recorder.stop();
  assert.deepEqual(pcm(), Buffer.from([1, 0, 2, 0]));
  assert.equal(recorder.recordedSeconds, 0.2);
});
