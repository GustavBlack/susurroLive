'use strict';
/** Regression checks for native subword output, contractions and zero-duration alignment. */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine, parseWhisperJson, cleanWhisperWords } = require('../src/main/whisper');
const { rebuildTranscript } = require('../src/main/assemble');
const { exportTxt, exportJson } = require('../src/main/exporters');

const item = (text, from, to) => ({ text, offsets: { from, to } });
const parse = (transcription, language = 'en') => parseWhisperJson(JSON.stringify({
  result: { language }, transcription,
}));

async function main() {
  // These are BPE fragments, not separate words. Alignment has no authority to delete text.
  const result = parse([
    item(' I', 0, 0), item("'m", 0, 100), item(' testing', 100, 400),
    item(' trans', 400, 400), item('cription', 400, 900), item('.', 900, 900),
    item(' I', 1000, 1100), item("'ll", 1000, 1000), item(' explain', 1100, 1400),
    item(' why', 1400, 1550), item(' we', 1550, 1750), item("'re", 1550, 1550),
    item(' recording', 1750, 2200), item(' un', 2200, 2200), item('believable', 2200, 2600),
    item(' words', 2600, 2900), item('.', 2900, 2900),
  ]);
  assert.equal(result.text, "I'm testing transcription. I'll explain why we're recording unbelievable words.");
  assert.deepEqual(result.words[0], { t: 0, d: 0.1, w: "I'm" });
  assert.deepEqual(result.words[2], { t: 0.4, d: 0.5, w: 'transcription.' });
  assert.equal(result.words[3].w, "I'll");
  assert.equal(result.language, 'en');
  assert.equal(cleanWhisperWords([{ t: 0, d: 0, w: 'I' }, { t: 0, d: 0, w: 'agree.' }]).length, 2);
  console.log('PASS contractions, subwords, punctuation and zero-duration text');

  const multilingual = parse([
    item(' Olá', 0, 100), item(',', 100, 100), item(' a', 100, 200),
    item(' transcri', 200, 250), item('ção', 250, 500), item(' é', 500, 600),
    item(' multi', 600, 700), item('língue', 700, 1000), item('.', 1000, 1000),
  ], 'pt');
  assert.equal(multilingual.text, 'Olá, a transcrição é multilíngue.');
  const cjk = parse([item('你好', 0, 300), item('世界', 300, 600), item('。', 600, 600)], 'zh');
  assert.equal(cjk.text, '你好世界。');
  assert.equal(cjk.words.length, 1);
  assert.equal(cjk.words[0].d, 0.6);
  assert.equal(parse([item('日本語', 0, 100), item('です', 100, 200), item('。', 200, 200)], 'ja').text, '日本語です。');
  assert.equal(parse([item('ภาษา', 0, 100), item('ไทย', 100, 200)], 'th').text, 'ภาษาไทย');
  assert.equal(parse([item('word', 0, 100), item(' ', 100, 100), item('boundary', 100, 200)]).text, 'word boundary');
  assert.equal(parse([item(' One whole segment.', 0, 2000)]).text, 'One whole segment.');
  const uncertain = parse([item(' retained', 'invalid', 300), item(' text', 500, 800)]);
  assert.equal(uncertain.text, 'retained text');
  assert.ok(uncertain.words.every(w => Number.isFinite(w.t) && Number.isFinite(w.d)));
  assert.equal(parse([item(' I', -10, -10), item("'m", 0, 100)]).text, "I'm");
  assert.throws(() => parseWhisperJson('{ broken'), /malformed JSON/);
  assert.throws(() => parseWhisperJson('{}'), /transcription array/);
  assert.deepEqual(parse([]).words, []);
  console.log('PASS multilingual text, segment fallback and malformed output errors');

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-whisper-text-'));
  try {
    const session = {
      id: 'text-regression', name: 'Text regression', folder, model: { language: 'en' },
      chunks: [{ index: 2, offsetSec: 4.25, status: 'done', words: result.words }],
    };
    const tr = rebuildTranscript(session);
    assert.equal(tr.fullText, result.text);
    assert.equal(tr.words[0].t, 4.25);
    assert.equal(tr.segments.map(s => s.text).join(' '), result.text);
    const txtFile = path.join(folder, 'transcript.txt');
    const jsonFile = path.join(folder, 'transcript.json');
    exportTxt(session, txtFile);
    exportJson(session, jsonFile);
    assert.ok(fs.readFileSync(txtFile, 'utf8').includes(result.text));
    assert.equal(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).transcript.fullText, result.text);
    const zhSession = { chunks: [{ index: 0, offsetSec: 0, status: 'done', words: cjk.words }], model: { language: 'zh' } };
    assert.equal(rebuildTranscript(zhSession).fullText, '你好世界。');
    console.log('PASS assembly offsets, sentence ranges and TXT/JSON exports');

    fs.writeFileSync(path.join(folder, 'ggml-large-v3-turbo.bin'), 'test model');
    fs.writeFileSync(path.join(folder, 'whisper-cli.exe'), 'test binary');
    const engine = new Engine({ binDir: folder, modelDir: folder });
    engine._run = async (_bin, args) => {
      assert.ok(args.includes('-sow'), 'native segments must keep whole words and UTF-8 codepoints');
      assert.equal(args[args.indexOf('-ml') + 1], '1');
      assert.ok(!args.includes('-nf'), 'disabling VAD must not disable decoding fallback');
      fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', JSON.stringify({
        result: { language: 'en' }, transcription: [item(" I'm", 0, 100), item(' ready.', 100, 500)],
      }));
    };
    for (const vad of [false, true]) {
      const native = await engine.transcribe(path.join(folder, 'test.wav'), { model: 'large-v3-turbo', vad });
      assert.equal(native.text, "I'm ready.");
      assert.equal(native.engine, 'whisper');
    }
    console.log('PASS CLI whole-word flag and quality fallback with both VAD preferences');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
