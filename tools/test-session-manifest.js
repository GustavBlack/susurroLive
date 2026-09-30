'use strict';
/**
 * AGENTS.md contract test: every session folder must self-describe.
 *   node tools/test-session-manifest.js
 *
 * Asserts, against the REAL session store:
 *   1. createSession() writes AGENTS.md into the folder it just made
 *   2. the embedded JSON Schema parses and agrees with SCHEMA_VERSION / the pipeline statuses
 *   3. folder structure + naming convention + rules are all present
 *   4. re-running ensureManifest() is a no-op (byte-identical, mtime untouched)
 *   5. a failed manifest write returns {ok:false} instead of throwing into recording
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/main/session');
const manifest = require('../src/main/agent-manifest');

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
}

const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-manifest-'));

console.log('\n=== 1. createSession writes AGENTS.md ===');
const session = store.createSession({
  parentDir: tmpParent,
  name: 'Weekly Sync',
  settings: { model: 'small.en', language: 'en', vad: true },
  gpu: null,
  model: { name: 'small.en', device: 'auto' },
  chunkSec: 30,
  sources: [],
});
const folder = session.folder;
const file = path.join(folder, manifest.FILENAME);

check('session.json exists', fs.existsSync(path.join(folder, 'session.json')));
check('AGENTS.md exists in the session folder', fs.existsSync(file), file);
check('folder name follows YYYY-MM-DD_HHMMSS_Slug',
  /^\d{4}-\d{2}-\d{2}_\d{6}_Weekly-Sync$/.test(path.basename(folder)),
  path.basename(folder));
check('AGENTS.md is beside session.json, not nested',
  fs.readdirSync(folder).includes(manifest.FILENAME));

const text = fs.readFileSync(file, 'utf8');
check('manifest is substantial (>4 KB)', text.length > 4000, `${text.length} bytes`);
check('no unsubstituted placeholders', !/\{\{/.test(text));
check('names the app version', text.includes(require('../package.json').version));

for (const dir of ['audio', 'transcripts', 'exports', 'temp']) {
  check(`documents ${dir}/`, text.includes(`${dir}/`) && fs.existsSync(path.join(folder, dir)));
}

console.log('\n=== 2. the embedded JSON Schema ===');
const fence = text.match(/```json\n([\s\S]*?)```/);
check('has a ```json schema block', !!fence);
let schema = null;
for (const block of text.match(/```json\n([\s\S]*?)```/g) || []) {
  const body = block.replace(/```json\n/, '').replace(/```$/, '');
  try {
    const parsed = JSON.parse(body);
    if (parsed && parsed.$schema) { schema = parsed; break; }
  } catch { /* not the schema block */ }
}
check('schema block parses as JSON', !!schema);
check('declares draft 2020-12', !!schema?.$schema?.includes('2020-12'));
check('requires version/chunks/transcript',
  ['version', 'chunks', 'transcript'].every((k) => schema?.required?.includes(k)));
check('version const matches SCHEMA_VERSION',
  schema?.properties?.version?.const === store.SCHEMA_VERSION,
  `schema ${schema?.properties?.version?.const} / store ${store.SCHEMA_VERSION}`);
check('chunk status enum matches the pipeline',
  JSON.stringify(schema?.properties?.chunks?.items?.properties?.status?.enum) ===
  JSON.stringify(['pending', 'queued', 'running', 'done', 'error']));

const defs = schema?.$defs || {};
const refs = JSON.stringify(schema || {}).match(/#\/\$defs\/(\w+)/g) || [];
const missing = [...new Set(refs.map((r) => r.split('/').pop()))].filter((d) => !defs[d]);
check('every $ref resolves to a $def', missing.length === 0, missing.join(', ') || 'all resolved');
check('chunkWord.t documented as chunk-local',
  /LOCAL to this chunk/.test(defs.chunkWord?.properties?.t?.description || ''));
check('globalWord.t documented as global',
  /GLOBAL/.test(defs.globalWord?.properties?.t?.description || ''));

// The documented enum must not drift from the real code.
const pipelineSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'pipeline.js'), 'utf8');
check('pipeline.js really uses those statuses',
  ['pending', 'queued', 'running', 'done', 'error'].every((s) => pipelineSrc.includes(`'${s}'`)));

const diar = schema?.properties?.diarization;
check('schema documents the optional diarization block',
  !!diar && JSON.stringify(diar.type) === JSON.stringify(['object', 'null']) && diar.required?.includes('turns'));
check('diarization turns are start/end/speaker on the global clock',
  ['start', 'end', 'speaker'].every((k) => defs.turn?.required?.includes(k)) &&
  /transcript\.words/.test(defs.turn?.properties?.start?.description || ''));

console.log('\n=== 3. the parts that must be explained ===');
check('naming convention section', /## 1 · Naming convention/.test(text) && text.includes('YYYY-MM-DD_HHMMSS'));
check('folder structure section', /## 2 · Folder structure/.test(text) && text.includes('chunk_0000.wav'));
check('schema section', /## 3 · `session\.json`/.test(text));
check('recipes section', /## 4 · Recipes/.test(text));
check('rules section', /## 5 · Rules that break naive readers/.test(text));
check('warns about the two timelines',
  /chunk-local/i.test(text) && /global/i.test(text) && text.includes('offsetSec'));
check('warns about demo output', text.includes('"demo"') || text.includes('`demo`') || /\bdemo\b/.test(text));
check('warns about non-done chunks meaning missing speech', /status != "done"/.test(text));
check('warns that exports are snapshots', /exports\/` and `exports\[\]` are snapshots/.test(text));
check('tells the agent to sort by index', /sort by index/.test(text));
check('manifest revision is current', text.includes(`| Manifest revision | ${manifest.MANIFEST_VERSION} |`));
check('no longer claims diarization does not exist', !/Diarization does not exist/.test(text));
check('recipe for joining speakers to words', /### 4\.6 Who said what/.test(text) && text.includes('def speaker_of'));
check('warns that speaker labels are not identities', /arrival order, not people/.test(text));

console.log('\n=== 4. refresh is idempotent ===');
const before = fs.statSync(file);
const again = store.ensureManifest(folder);
const after = fs.statSync(file);
check('ensureManifest reports the file already current', again.ok && again.changed === false);
check('mtime untouched', before.mtimeMs === after.mtimeMs);
check('bytes untouched', fs.readFileSync(file, 'utf8') === text);

console.log('\n=== 5. failure is non-fatal, never a throw ===');
const blocker = path.join(tmpParent, 'not-a-directory.txt');
fs.writeFileSync(blocker, 'x');
let threw = false;
let res;
try { res = manifest.write(blocker, { appVersion: '0', schemaVersion: 1 }); }
catch { threw = true; }
check('write() does not throw on an impossible path', !threw);
check('write() returns {ok:false, error}', res && res.ok === false && !!res.error);
let createThrew = false;
try {
  store.createSession({ parentDir: tmpParent, name: 'Still Works', settings: {}, gpu: null, chunkSec: 30 });
} catch { createThrew = true; }
check('createSession still succeeds (it did not depend on the failing write)', !createThrew);

console.log('\n=== 6. optional diarization block survives the store ===');
const block = {
  version: 1, engine: 'test', model: 'm', createdAt: new Date().toISOString(), audioSec: 4, speakers: 2,
  turns: [{ start: 0, end: 2, speaker: 'spk0' }, { start: 2, end: 4, speaker: 'spk1' }],
};
session.diarization = block;
store.writeSession(folder, session);
const reopened = store.openSession(folder);
check('block round-trips through write/open', reopened.ok && JSON.stringify(reopened.session.diarization) === JSON.stringify(block));
check('schema version is still 1 (additive block, no bump)', reopened.session.version === 1 && store.SCHEMA_VERSION === 1);

const raw = JSON.parse(fs.readFileSync(path.join(folder, 'session.json'), 'utf8'));
raw.diarization = { turns: 'corrupt' };
fs.writeFileSync(path.join(folder, 'session.json'), JSON.stringify(raw));
const warn = console.warn;
console.warn = () => {};
const corrupt = store.openSession(folder);
check('malformed block does not block the open', corrupt.ok);
check('malformed block is dropped', corrupt.ok && !('diarization' in corrupt.session));

const upd = store.updateSessionFile(folder, (s) => { s.diarization = block; });
console.warn = warn;
const after2 = JSON.parse(fs.readFileSync(path.join(folder, 'session.json'), 'utf8'));
check('updateSessionFile writes a non-active session', upd.ok && after2.diarization?.turns?.length === 2);
check('updateSessionFile reports a missing folder', store.updateSessionFile(path.join(tmpParent, 'nope'), () => {}).ok === false);

// cleanup
try { fs.rmSync(tmpParent, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}\n`);
process.exit(failures === 0 ? 0 : 1);
