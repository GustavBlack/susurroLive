'use strict';
/** Inspect a session folder: node tools/inspect-session.js <folder> */
const fs = require('fs');
const path = require('path');

const folder = process.argv[2];
if (!folder) { console.error('usage: node tools/inspect-session.js <folder>'); process.exit(1); }

const s = JSON.parse(fs.readFileSync(path.join(folder, 'session.json'), 'utf8'));

console.log('session   :', s.name, '| chunks:', s.chunks.length);
console.log('recording :', s.recording.startedAt, '->', s.recording.stoppedAt, '| dur', s.recording.durationSec, 's | rate', s.recording.sampleRate);
console.log('\nchunks:');
for (const c of s.chunks) {
  const lw = c.words || [];
  const last = lw[lw.length - 1];
  console.log(
    `  idx ${c.index}  offset ${String(c.offsetSec).padStart(4)}  dur ${String(c.durationSec).padStart(6)}  ` +
    `status ${c.status.padEnd(6)}  n=${String(lw.length).padStart(3)}  ` +
    `local[${lw[0] ? lw[0].t : '-'} .. ${last ? (last.t + last.d).toFixed(2) : '-'}]  ` +
    `engine=${c.engine || '-'}  file=${c.audioFile}`,
  );
}

const w = s.transcript.words;
const last = w[w.length - 1];
console.log(`\nglobal words: ${w.length}`);
if (w.length) {
  console.log(`  first: t=${w[0].t} ${JSON.stringify(w[0].w)}`);
  console.log(`  last : t=${last.t} d=${last.d} end=${(last.t + last.d).toFixed(2)} ${JSON.stringify(last.w)}`);
  console.log(`  words with t > 5s : ${w.filter((x) => x.t > 5).length}`);
  const over = w.filter((x) => x.t + x.d > s.recording.durationSec + 2);
  console.log(`  words PAST audio end + 2s : ${over.length}${over.length ? '  e.g. ' + JSON.stringify(over.slice(0, 3)) : ''}`);
}
console.log(`segments: ${s.transcript.segments.length}`);
console.log('\ntext:\n' + (s.transcript.fullText || '(none)'));
