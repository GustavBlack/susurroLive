'use strict';
/**
 * Export formats with and without speaker diarization.
 *   node tools/test-exporters.js
 *
 *   1. no diarization block -> .txt and .json are exactly the pre-diarization output
 *   2. with a block -> .txt has one paragraph per speaker turn, .json carries the block and a
 *      derived `spk` on every word
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exportTxt, exportJson } = require('../src/main/exporters');
const { rebuildTranscript } = require('../src/main/assemble');

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-exporters-'));
const W = (t, w) => ({ t, d: 0.3, w });
const session = {
  id: 'id-1', name: 'Weekly Sync', createdAt: '2026-09-24T10:00:00.000Z', folder: dir,
  recording: { startedAt: '2026-09-24T10:00:00.000Z', durationSec: 12.5, sources: [] },
  model: { name: 'small.en', device: 'cuda', language: 'en' },
  chunks: [{
    index: 0, offsetSec: 0, durationSec: 12.5, status: 'done', engine: 'whisper', audioFile: 'audio/chunk_0000.wav',
    words: [W(0.2, 'Good'), W(0.6, 'morning,'), W(1.0, 'everyone.'), W(4.1, 'Hi'), W(4.5, 'there.'),
      W(9.0, 'Thanks'), W(9.4, 'for'), W(9.8, 'joining!')],
  }],
};
rebuildTranscript(session);

console.log('\n=== 1. undiarized exports are unchanged ===');
const txt0 = path.join(dir, 'plain.txt');
exportTxt(session, txt0);
const expectedTxt = [
  'Weekly Sync',
  'Recorded: 2026-09-24T10:00:00.000Z',
  'Duration: 00:12.50  |  Model: small.en  |  Device: cuda',
  '',
  '-'.repeat(60),
  'Good morning, everyone. Hi there. Thanks for joining!',
  '',
].join('\n');
check('.txt byte-identical to the pre-diarization format', fs.readFileSync(txt0, 'utf8') === expectedTxt);

const json0 = path.join(dir, 'plain.json');
exportJson(session, json0);
const expectedJson = JSON.stringify({
  session: { id: 'id-1', name: 'Weekly Sync', createdAt: '2026-09-24T10:00:00.000Z', durationSec: 12.5 },
  model: session.model,
  sources: [],
  transcript: {
    language: 'en', fullText: session.transcript.fullText,
    words: session.transcript.words, segments: session.transcript.segments,
  },
  chunks: [{ index: 0, offsetSec: 0, durationSec: 12.5, status: 'done', engine: 'whisper', audioFile: 'audio/chunk_0000.wav' }],
}, null, 2);
check('.json byte-identical to the pre-diarization format', fs.readFileSync(json0, 'utf8') === expectedJson);

console.log('\n=== 2. diarized exports ===');
session.diarization = {
  version: 1, engine: 'test', model: 'm', createdAt: '2026-09-24T11:00:00.000Z', audioSec: 12.5, speakers: 2,
  turns: [
    { start: 0.0, end: 2.0, speaker: 'spk0' },
    { start: 3.8, end: 5.0, speaker: 'spk1' },
    { start: 8.8, end: 11.0, speaker: 'spk0' },
  ],
};
const txt1 = path.join(dir, 'speakers.txt');
exportTxt(session, txt1);
const txt = fs.readFileSync(txt1, 'utf8');
check('header names the speaker count', txt.includes('Speakers: 2 (numbered by order of first speaking)'));
const body = txt.split(`${'-'.repeat(60)}\n`)[1];
check('one paragraph per speaker turn', body === [
  'Speaker 1: Good morning, everyone.',
  'Speaker 2: Hi there.',
  'Speaker 1: Thanks for joining!',
].join('\n\n') + '\n', JSON.stringify(body));

const json1 = path.join(dir, 'speakers.json');
exportJson(session, json1);
const doc = JSON.parse(fs.readFileSync(json1, 'utf8'));
check('.json carries the diarization block', doc.diarization?.turns?.length === 3 && doc.diarization.speakers === 2);
check('every exported word has a derived spk',
  JSON.stringify(doc.transcript.words.map((w) => w.spk)) ===
  JSON.stringify(['spk0', 'spk0', 'spk0', 'spk1', 'spk1', 'spk0', 'spk0', 'spk0']));
check('session.json words are not mutated by export', !('spk' in session.transcript.words[0]));

console.log('\n=== 3. words outside every turn ===');
session.diarization.turns = [{ start: 3.8, end: 5.0, speaker: 'spk0' }];
const txt2 = path.join(dir, 'gap.txt');
exportTxt(session, txt2);
const body2 = fs.readFileSync(txt2, 'utf8').split(`${'-'.repeat(60)}\n`)[1];
check('leading unattributed words -> "Speaker ?", trailing ones continue the turn', body2 === [
  'Speaker ?: Good morning, everyone.',
  'Speaker 1: Hi there. Thanks for joining!',
].join('\n\n') + '\n', JSON.stringify(body2));

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
