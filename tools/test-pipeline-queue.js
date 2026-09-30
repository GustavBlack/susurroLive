'use strict';
// Stop/retry while a pause-finalized chunk is still transcribing must not run it twice.
const assert = require('node:assert/strict');
const { Pipeline } = require('../src/main/pipeline');

async function main() {
  const session = {
    folder: '', model: {},
    chunks: [0, 1].map(index => ({ index, offsetSec: index * 2, durationSec: 2,
      audioFile: `chunk_${index}.wav`, status: 'pending' })),
  };
  const calls = [];
  const releases = [];
  const pipeline = new Pipeline({
    engine: { transcribe: (_path, { chunkIndex }) => {
      calls.push(chunkIndex);
      return new Promise(resolve => releases.push(() => resolve({ words: [], text: '', engine: 'test' })));
    } },
    getSession: () => session, onPersist() {}, emit() {}, device: 'cpu',
  });
  pipeline.concurrency = 2;
  pipeline.enqueue(0);
  pipeline.enqueueAllOutstanding();
  pipeline.enqueueAllOutstanding();
  assert.deepEqual(calls, [0, 1], 'requeue must not duplicate an in-flight decoder');
  assert.equal(pipeline.running, 2);
  // Force sidecar writes to fail harmlessly: this is a queue-only test, not session I/O.
  session.folder = '\0';
  releases.forEach(resolve => resolve());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pipeline.running, 0);
  assert.equal(pipeline.remaining, 0);
  assert.deepEqual(session.chunks.map(c => c.attempts), [1, 1]);
  assert.ok(session.chunks.every(c => c.status === 'done'));
  console.log('PASS stop/retry preserves in-flight jobs and drains once');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
