'use strict';
/**
 * LLM checkup harness tests: a local stub HTTP server, every case against the REAL
 * src/main/llm/client.js / checkup.js / vocabulary.js — no mocks of the code under test.
 *   node tools/test-llm-harness.js
 *
 * This file is the documentation-by-example for think vs non-think response handling (plan B7).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// Build think-tag literals via concatenation — text tooling has mangled this literal before.
const THINK_OPEN = '<' + 'think' + '>';
const THINK_CLOSE = '<' + '/' + 'think' + '>';

const client = require('../src/main/llm/client');
const checkup = require('../src/main/llm/checkup');
const { createVocabulary } = require('../src/main/llm/vocabulary');

// Sanity: the source builds its tags the same way (guard against codepoint mangling).
assert.equal(client.THINK_OPEN, THINK_OPEN);
assert.equal(client.THINK_CLOSE, THINK_CLOSE);
assert.equal([...client.THINK_OPEN].length, 7, 'THINK_OPEN is exactly 7 codepoints');
assert.equal([...client.THINK_CLOSE].length, 8, 'THINK_CLOSE is exactly 8 codepoints');

const passed = [];
function pass(name) { passed.push(name); console.log('  PASS  ' + name); }

// ------------------------------------------------------------------ stub server
let nextResponse = null;   // { status, headers?, body } — one-shot per chat/probe call
let lastChatBody = null;   // captured request body of the last chat call
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const r = nextResponse || { status: 500, body: { error: 'no scripted response' } };
    if (req.url.endsWith('/chat/completions')) {
      try { lastChatBody = JSON.parse(raw); } catch { lastChatBody = null; }
    }
    res.writeHead(r.status, r.headers || { 'Content-Type': 'application/json' });
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  });
});
async function listen() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}

// ------------------------------------------------------------------ fixtures
function makeWords(n, chunkEvery = 10) {
  const words = [];
  for (let i = 0; i < n; i++) {
    words.push({ t: i * 0.4, d: 0.3, w: 'word' + i, chunk: Math.floor(i / chunkEvery) });
  }
  return words;
}

function editsJson(pairs) {
  return JSON.stringify({ edits: pairs.map(([i, w]) => ({ i, w })) });
}

async function main() {
  const base = await listen();

  // ---- case 1: plain model content JSON -> parsed + applied (full runCheckup round trip)
  {
    const words = makeWords(6);
    words[2].w = 'thier'; // the error the model will correct
    nextResponse = { status: 200, body: { choices: [{ message: { content: editsJson([[2, 'their'], [5, 'word5!']]) } }] } };
    const block = await checkup.runCheckup({
      session: { transcript: { words } },
      settings: { llmEndpoint: base, llmModel: 'plain-8b', llmContextTokens: 8192 },
    });
    assert.equal(block.applied, 2);
    assert.equal(block.edits[0].i, 2);
    assert.equal(block.edits[0].orig, 'thier');
    assert.equal(block.edits[0].w, 'their');
    assert.equal(block.active, true);
    const { words: projected } = checkup.applyCheckup(words, block);
    assert.equal(projected[2].w, 'their');
    assert.equal(projected[5].w, 'word5!');
    // non-destructive: the stored array is untouched
    assert.equal(words[2].w, 'thier');
    // request shape: temperature 0, stream false, model + messages present
    assert.equal(lastChatBody.temperature, 0);
    assert.equal(lastChatBody.stream, false);
    assert.equal(lastChatBody.model, 'plain-8b');
    assert.ok(Array.isArray(lastChatBody.messages) && lastChatBody.messages[0].role === 'system');
    pass('1 plain model content JSON -> parsed + applied');
  }

  // ---- case 2: closed think-tag-wrapped content -> stripped, parsed
  {
    const inner = 'Let me think about the transcript... ' + editsJson([[1, 'fixed']]);
    const wrapped = THINK_OPEN + inner + THINK_CLOSE + editsJson([[1, 'fixed']]);
    nextResponse = { status: 200, body: { choices: [{ message: { content: wrapped } }] } };
    const res = await client.chat({ base, model: 'qwen3', messages: [{ role: 'user', content: 'x' }] });
    assert.ok(!res.content.includes(THINK_OPEN), 'think block stripped from content');
    assert.equal(res.reasoning, null);
    assert.deepEqual(res.parsed, { edits: [{ i: 1, w: 'fixed' }] });
    pass('2 closed think-tag-wrapped content -> stripped, parsed');
  }

  // ---- case 3: unclosed think tag -> reasoning stripped, answer kept
  {
    // The model omitted the closing tag and the JSON follows the reasoning text:
    // everything from the tag to the first JSON-like token goes, answer stays.
    const content = THINK_OPEN + 'rambling forever with no close tag... ' + editsJson([[0, 'yes']]);
    nextResponse = { status: 200, body: { choices: [{ message: { content } }] } };
    const res = await client.chat({ base, model: 'qwen3', messages: [{ role: 'user', content: 'x' }] });
    assert.ok(!res.content.includes(THINK_OPEN), 'unclosed think tag stripped from content');
    assert.ok(!res.content.includes('rambling forever'), 'leaked reasoning stripped');
    assert.deepEqual(res.parsed, { edits: [{ i: 0, w: 'yes' }] });
    pass('3 unclosed think tag -> reasoning stripped, answer kept');
  }

  // ---- case 4: reasoning_content + clean content -> parsed from content, reasoning captured
  {
    nextResponse = { status: 200, body: { choices: [{ message: {
      reasoning_content: 'I checked every word carefully.',
      content: editsJson([[3, 'corrected']]),
    } }] } };
    const res = await client.chat({ base, model: 'deepseek-r1', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.reasoning, 'I checked every word carefully.');
    assert.deepEqual(res.parsed, { edits: [{ i: 3, w: 'corrected' }] });
    // a `reasoning` field (OpenRouter style) is captured too
    nextResponse = { status: 200, body: { choices: [{ message: {
      reasoning: 'alt field', content: editsJson([[3, 'corrected']]),
    } }] } };
    const res2 = await client.chat({ base, model: 'm', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res2.reasoning, 'alt field');
    pass('4 reasoning_content + clean content -> parsed from content, reasoning captured');
  }

  // ---- case 5: 401 chat -> LLMAuthError with the "requires an API key" message
  {
    nextResponse = { status: 401, body: { error: { message: 'bad key' } } };
    await assert.rejects(
      () => client.chat({ base, model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      (err) => err instanceof client.LLMAuthError && /requires an API key/.test(err.message),
    );
    // 403 on probe is the same typed error
    nextResponse = { status: 403, body: {} };
    await assert.rejects(() => client.probeModels(base), client.LLMAuthError);
    pass('5 401 chat -> LLMAuthError "requires an API key"');
  }

  // ---- case 6: parseEdits validator + applyCheckup projection
  {
    const words = makeWords(8, 4); // chunks 0 (0-3), 1 (4-7)
    const range = [0, 8];
    const edits = checkup.parseEdits(editsJson([
      [-1, 'nope'],      // out of range (below)
      [99, 'nope'],      // out of range (above)
      [1, 'two words'],  // whitespace-bearing w
      [2, words[2].w],   // identity edit
      [3, 'valid'],
    ]), range, words);
    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0], { i: 3, orig: 'word3', w: 'valid' });

    // applyCheckup: edits change only w; t/d byte-identical
    const block = {
      active: true,
      edits: [{ i: 3, orig: 'word3', w: 'valid' }, { i: 6, orig: 'word6', w: 'six' }],
      chunkHashes: checkup.chunkHashes(words),
    };
    const { words: out } = checkup.applyCheckup(words, block);
    assert.equal(out[3].w, 'valid');
    assert.equal(out[6].w, 'six');
    for (let i = 0; i < words.length; i++) {
      assert.equal(out[i].t, words[i].t, 't untouched at ' + i);
      assert.equal(out[i].d, words[i].d, 'd untouched at ' + i);
      assert.equal(out[i].chunk, words[i].chunk);
    }

    // drift: chunk 1's fingerprint no longer matches -> its edits skipped AND reported
    const driftedWords = words.slice();
    driftedWords[6] = { ...driftedWords[6], w: 'retranscribed' }; // simulate re-transcription
    const r2 = checkup.applyCheckup(driftedWords, block);
    assert.deepEqual(r2.driftedChunkIds, ['1']);
    assert.equal(r2.words[6].w, 'retranscribed', 'drifted chunk keeps original words');
    assert.equal(r2.words[3].w, 'valid', 'other chunks stay checked-up');

    // orig mismatch: stored word changed since the checkup -> that edit skipped
    const changed = words.slice();
    changed[3] = { ...changed[3], w: 'something-else' };
    const r3 = checkup.applyCheckup(changed, block);
    assert.equal(r3.words[3].w, 'something-else', 'stale orig edit skipped');
    assert.equal(r3.words[6].w, 'six');
    // changing word3 also changed chunk 0's fingerprint -> it is reported as drifted too
    assert.deepEqual(r3.driftedChunkIds, ['0']);

    // active:false -> original unchanged
    const r4 = checkup.applyCheckup(words, { ...block, active: false });
    assert.deepEqual(r4.words.map((w) => w.w), words.map((w) => w.w));
    assert.deepEqual(r4.driftedChunkIds, []);
    // no checkup block at all
    assert.deepEqual(checkup.applyCheckup(words, null).words.map((w) => w.w), words.map((w) => w.w));
    pass('6 validator drops bad edits; projection guards t/d, drift, stale orig, active:false');
  }

  // ---- case 7: buildBatches — 10k-word transcript at context 4096
  {
    const words = makeWords(10000, 100);
    const batches = checkup.buildBatches(words, 4096);
    assert.ok(batches.length > 1, 'multiple batches, got ' + batches.length);
    const budget = 4096 - Math.max(512, Math.floor(4096 * 0.25));
    let prevEnd = -1;
    for (const b of batches) {
      const est = checkup.estimateTokens(words, b.range[0], b.range[1], false);
      assert.ok(est <= budget, `batch ${b.range} estimate ${est} under budget ${budget}`);
      assert.equal(b.range[0], prevEnd + 1, 'ranges contiguous');
      prevEnd = b.range[1] - 1;
      // preamble: exactly 40 leading words (less at the very start), ending where the batch starts
      assert.deepEqual(b.preambleWords, [Math.max(0, b.range[0] - 40), b.range[0]]);
      if (b.range[0] >= 40) assert.equal(b.preambleWords[1] - b.preambleWords[0], 40, '40-word preamble');
      // the preamble is exactly the previous batch's last 40 words (overlap correctness)
      if (batches.indexOf(b) > 0 && b.range[0] >= 40) {
        const prev = batches[batches.indexOf(b) - 1];
        assert.equal(prev.range[1] - b.preambleWords[0], 40);
      }
    }
    assert.equal(prevEnd, words.length - 1, 'batches cover the whole timeline');
    // prompt builder honors the preamble and vocabulary
    const msgs = checkup.buildMessages(words, batches[3], ['PartUV', 'susurroLive'], null);
    const user = msgs[1].content;
    assert.ok(user.startsWith('vocabulary (known terms — prefer these spellings):'));
    assert.ok(user.includes('- PartUV'));
    assert.ok(user.includes('context — do not edit:'));
    assert.ok(user.includes(checkup.PREAMBLE_WORDS - 1 + '|'));
    assert.ok(user.includes(batches[3].range[0] + '|'));
    pass('7 buildBatches: contiguous ranges, under budget, 40-word preambles');
  }

  // ---- case 8: probeModels — LM Studio vs OpenAI /models shapes
  {
    nextResponse = { status: 200, body: { data: [
      { id: 'qwen3-8b', meta: { context_length: 16384 } },
      { id: 'other' },
    ] } };
    const lm = await client.probeModels(base);
    assert.equal(lm.ok, true);
    assert.deepEqual(lm.models.map((m) => m.id), ['qwen3-8b', 'other']);
    assert.equal(lm.contextTokens, 16384);

    nextResponse = { status: 200, body: { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] } };
    const openai = await client.probeModels(base);
    assert.equal(openai.contextTokens, null);
    assert.deepEqual(openai.models.map((m) => m.id), ['gpt-4o-mini', 'gpt-4o']);
    // Authorization header only when a key exists
    nextResponse = { status: 200, body: { data: [{ id: 'm' }] } };
    await client.probeModels(base, 'sk-test');
    // (server echoed nothing; absence of throw + ok above covers the request path)
    pass('8 probeModels: LM Studio contextTokens extracted; OpenAI shape -> null');
  }

  // ---- case 9: vocabulary against a real temp dir
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susurro-vocab-'));
    const vocab = createVocabulary(dir);
    const seeded = vocab.load();
    assert.equal(seeded.ok, true);
    assert.ok(fs.existsSync(vocab.file), 'seeded file created on first load');
    assert.equal(seeded.data.profiles[0].id, 'default');
    assert.ok(seeded.data.profiles[0].terms.includes('susurroLive'));

    // activeTerms dedupes across profiles case-insensitively
    vocab.upsertProfile({ id: 'gaming', name: 'Gaming', active: true, terms: ['partuv', ' SPEEDRUN ', 'speedrun'] });
    vocab.upsertProfile({ id: 'idle', name: 'Idle', active: false, terms: ['inactive-term'] });
    const terms = vocab.activeTerms();
    const lowers = terms.map((t) => t.toLowerCase());
    assert.deepEqual(lowers, [...new Set(lowers)], 'no case-insensitive duplicates');
    assert.ok(!terms.includes('inactive-term'), 'inactive profile contributes nothing');
    assert.equal(lowers.filter((t) => t === 'partuv').length, 1, 'deduped across profiles');

    // setActive round-trips through the real file
    assert.equal(vocab.setActive('gaming', false).ok, true);
    const reloaded = JSON.parse(fs.readFileSync(vocab.file, 'utf8'));
    assert.equal(reloaded.profiles.find((p) => p.id === 'gaming').active, false);
    // PartUV remains (the seeded default profile also carries it); a gaming-only term drops out
    assert.ok(vocab.activeTerms().map((t) => t.toLowerCase()).includes('partuv'));
    assert.ok(!vocab.activeTerms().map((t) => t.toLowerCase()).includes('speedrun'));
    assert.equal(vocab.setActive('gaming', true).ok, true);
    assert.ok(vocab.activeTerms().map((t) => t.toLowerCase()).includes('partuv'));

    // malformed JSON -> empty terms, no throw
    fs.writeFileSync(vocab.file, '{ this is not json !!!');
    assert.deepEqual(vocab.activeTerms(), []);
    assert.equal(vocab.load().ok, false);
    // valid JSON with a broken shape -> also empty, no throw
    fs.writeFileSync(vocab.file, JSON.stringify({ version: 1, nope: true }));
    assert.equal(vocab.load().ok, false);
    assert.deepEqual(vocab.activeTerms(), []);
    fs.rmSync(dir, { recursive: true, force: true });
    pass('9 vocabulary: seed, dedupe, malformed fallback, setActive round-trip');
  }

  server.close();
  console.log('\nLLM HARNESS: PASS (' + passed.length + ' cases)');
}

main().catch((err) => {
  console.error(err && err.stack || err);
  try { server.close(); } catch { /* ignore */ }
  process.exitCode = 1;
});
