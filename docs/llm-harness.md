# The LLM Harness — message submission, normalization, and the non-destructive data model

> Foundation doc for every future LLM-on-transcript feature in susurroLive (1.6.0+).
> Everything here is implemented and executable: `node tools/test-llm-harness.js` runs
> all nine cited cases against the real `src/main/llm/client.js`, `checkup.js`, and
> `vocabulary.js` (a local stub HTTP server, no mocks of the code under test).

Modules:

- `src/main/llm/client.js` — OpenAI-compatible HTTP client, response normalization, typed errors.
- `src/main/llm/checkup.js` — batching, prompt building, edit validation, projection, orchestration.
- `src/main/llm/vocabulary.js` — user-owned vocabulary profiles (`userData/vocabulary.json`).
- IPC (`src/main/index.js`) — channels `llm:probe`, `llm:checkup:run`, `llm:checkup:cancel`,
  `llm:checkup:toggle`, `llm:checkup:discard`, `llm:vocab:list/save/reveal`; events
  `llmCheckupProgress {done,total}`, `llmCheckupDone {applied}`, `llmCheckupError {message, cancelled?}`.

## 1. Message submission

The harness sends exactly two messages to `POST {base}/chat/completions`:

```js
{ model, messages: [system, user], temperature: 0, stream: false,
  max_tokens: Math.max(256, Math.floor(contextTokens * 0.25)) }  // only when contextTokens > 0
```

Temperature is always 0 for correction (determinism beats creativity). `Authorization: Bearer <key>`
is sent only when a key is configured — empty key means the endpoint needs none.

### System prompt (verbatim, `checkup.SYSTEM_PROMPT`)

> You are correcting ASR (speech-to-text) output. Return ONLY a JSON object
> `{"edits":[{"i":<index>,"w":"<replacement>"}]}` — no prose, no markdown fences around the whole
> answer. Fix ONLY obvious transcription errors: wrong homophones, mangled proper nouns, wrong
> acronyms or version strings, duplicated stutters. Never add, delete, merge, or reorder words —
> one-to-one replacements only. Never change the casing of code-like tokens unless clearly wrong.
> Prefer leaving a word unchanged when unsure.

### User prompt (`checkup.buildMessages(words, batch, vocabulary, speakerAt)`)

```
vocabulary (known terms — prefer these spellings):
- PartUV
- whisper.cpp

context — do not edit:
S1 ~|word12
~|word13
words to review:
S1 14|word14
15|word15
```

- Words to review are numbered `i|word` lines where `i` is the word's index in the session's
  global timeline — the same `i` the model must echo back in its edits.
- Preamble (context) words use `~|` instead of an index so the model cannot edit them.
- Speaker tags (`S1 `, `S2 `, … from diarize-join) prefix lines when the session is diarized;
  they are simply omitted when it is not (failed or unavailable diarizer). The correction rules
  are identical for both transcript structures.
- The vocabulary block (when any terms are active) leads the user message.

## 2. Batch / context math

`buildBatches(words, contextTokens)` splits the global word timeline into contiguous batches:

| Constant | Value | Meaning |
| --- | --- | --- |
| `PROMPT_OVERHEAD` | 256 tokens | system prompt + JSON framing, added to every estimate |
| `PREAMBLE_WORDS` | 40 words | leading context attached to every batch |
| reserve | `max(512, 25% of context)` | response budget withheld from the prompt estimate |
| token estimate | `ceil((chars/4) * 1.3) + 256` | chars/4 heuristic with a 1.3x safety factor |

Per-word char counting includes the `i|word` framing (+6) and, when diarized, the speaker tag
(+4). A batch grows while `estimateTokens(start, end+1) <= contextTokens - reserve`; ranges are
contiguous and cover the whole timeline. Each batch carries `preambleWords: [start-40, start]` —
exactly the previous batch's last 40 words — labeled "context — do not edit" so the model sees
sentence boundaries across batch seams.

Default context is 8192 tokens; `llmContextTokens` in settings (user-editable) is normally
auto-filled by the probe (see §4).

## 3. Response normalization pipeline

Every response passes through one pipeline in `client.chat()`:

1. **Reasoning split.** If `choices[0].message.reasoning_content` (LM Studio / vLLM style) or
   `message.reasoning` (OpenRouter style) is a string, it is captured as `reasoning` and the
   `content` field is treated as the answer (think-tag stripping is skipped —
   the server already separated the two).
2. **Think-tag strip** (`normalize(content, reasoning, thinkStrip)`) — only when no
   `reasoning` field exists and `llmThinking !== 'off'`:
   - a closed block — from the opening tag `<think>` through its closing tag `</think>` —
     is removed;
   - an **unclosed** tag is stripped from the tag to the first JSON-like token (a markdown fence
     or `{`) — the answer after it is kept;
   - **the tag is kept untouched when nothing JSON-like follows it**, so a legitimate answer that
     merely contains the string `<think>` (e.g. JSON escaping exercise) survives intact.
3. **JSON extraction** (`extractJson`): markdown fences are tried first, then the raw text; the
   first *balanced* `{...}` object (string- and escape-aware) is returned via `JSON.parse`.
   The result lands on `parsed`.

Per-endpoint override: `llmThinking: 'auto' | 'off'` in settings. `'off'` disables step 2 for
models that legitimately emit code containing think-tag strings (rare; `'auto'` is the default).

The client returns `{ content, reasoning, raw, parsed }`.

## 4. Per-server quirks

| Server | Behavior |
| --- | --- |
| **LM Studio** | `GET /v1/models` entries carry `meta.context_length`; `pickContextTokens` extracts it (also tolerating `context_length` / `contextLength` / `max_context_length` / `limits.context_length` at the model or top level) and the UI auto-fills `llmContextTokens`. Thinking models may emit `<think>` blocks in `content`. |
| **llama.cpp server** (`llama-server --host …`) | OpenAI-compatible `/v1/chat/completions` and `/v1/models`; usually no context metadata in `/models` → the probe returns `contextTokens: null` and the user's setting stands. |
| **Ollama (OpenAI shim)** | Serve via `http://127.0.0.1:11434/v1`; the shim accepts the same chat shape. API key may be any non-empty string or empty. |
| **Plain vLLM** | Standard OpenAI API; `reasoning_content` present for reasoning models; context probing depends on the served model's `--max-model-len` config, not `/models`. |

Probe contract (`probeModels(endpoint, apiKey)`): `{ ok: true, models: [{id}], contextTokens }`
— `contextTokens` is `null` when the server exposes nothing (case 8 in the harness test).

## 5. The non-destructive data model

This is the load-bearing invariant of the whole feature. **Stored words NEVER mutate.**

- `session.transcript.words` on disk are the original ASR output, always — `{t, d, w, chunk}`
  (plus `speaker` when diarized), `SCHEMA_VERSION 2` shape.
- Corrections persist as a `checkup` block on the session (written by `saveCheckupBlock` in
  `src/main/index.js`):

```json
"checkup": {
  "active": true,
  "model": "qwen3-8b",
  "endpoint": "http://127.0.0.1:1234/v1",
  "applied": 23,
  "batches": 4,
  "at": "2026-10-18T04:12:00Z",
  "vocabulary": ["PartUV"],
  "chunkHashes": { "3": "1a2b9c0d", "4": "77e0d1aa" },
  "edits": [{ "i": 152, "orig": "war", "w": "was" }]
}
```

- `applyCheckup(words, checkup)` is the **pure read-time projection** (`checkup.js`, exported):
  it returns a *new* word array where edit `e` applies only when (a) the word's chunk fingerprint
  matches `checkup.chunkHashes[chunk]` and (b) the stored word still equals `e.orig`
  (belt-and-braces). `t` and `d` are copied through untouched. Drifted chunk ids come back in
  `driftedChunkIds`. The session store is never mutated through this path.
- `checkup.active` is the user's corrected/original toggle: the renderer transcript payload and
  **all exports** route through `projectedWords(session)` (`src/main/exporters.js`), which
  applies the projection only when a block exists — so the export always mirrors exactly what the
  UI shows (a drifted chunk exports original while the rest export corrected). Without a block,
  exports are byte-identical to pre-1.6.0.
- `llm:checkup:discard` deletes the `checkup` block entirely — pure original again.
- A re-run replaces the whole block (clean slate): new edit list, fresh `chunkHashes`, new
  `applied` count. There is no per-chunk re-checkup; retranscription is rare, so the
  lightweight whole-session re-run was chosen deliberately.

**Retranscription drift.** `chunkHashes(words)` computes a per-chunk FNV-1a (32-bit, hex) over
the chunk's space-joined word texts (words without a `chunk` field fall under a synthetic `''`
bucket and are guarded only by `edit.orig`). When a chunk is later re-transcribed, its current
fingerprint differs from the stored one → that chunk's edits are dropped from the projection, its
words are reported in `driftedChunkIds`, and the UI marks them "drifted" while the rest of the
session stays corrected. Re-running the checkup refreshes everything.

## 6. vocabulary.json format

`<userData>/vocabulary.json` — deliberately a standalone plain JSON file the user can edit by
hand or with an external LLM/tool:

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "default",
      "name": "Default",
      "active": true,
      "terms": ["susurroLive", "whisper.cpp", "sm_120", "PartUV"]
    },
    { "id": "tech-meetings", "name": "Tech meetings", "active": false, "terms": [] }
  ]
}
```

- Seeded with the `default` profile on first `load()` if the file is missing.
- **No cache:** re-read from disk on every checkup run and every drawer open — the user owns the
  file and may edit it while the app runs.
- `activeTerms()` concatenates active profiles in file order, deduped case-insensitively, and
  never throws: malformed JSON or a broken shape degrades to an empty term list (a checkup run
  proceeds without vocabulary; the malformed state is surfaced in the drawer, not fed into a
  prompt).
- Module API: `createVocabulary(dir)` → `{ file, load, save, activeTerms, upsertProfile,
  setActive, revealFile }`; IPC: `llm:vocab:list`, `llm:vocab:save`, `llm:vocab:reveal`.
- `runCheckup` snapshots `activeTerms()` into the block's `vocabulary` field so a later reader
  knows which terms were in the prompt.

## 7. Error taxonomy

All errors are typed subclasses of `LLMError` in `client.js`; the renderer surfaces
`err.message` verbatim.

| Class | Trigger | Message |
| --- | --- | --- |
| `LLMAuthError` | HTTP 401/403 (chat or probe) | "endpoint requires an API key — enter it in Settings" |
| `LLMBadEndpoint` | non-JSON response body, HTTP 404, unreachable URL, missing `choices[0].message` | "endpoint did not respond with a valid API response (check the URL)" (or more specific) |
| `LLMTimeout` | request exceeds 120 s (AbortController timer) | "request timed out" |
| `LLMHttpError` | any other non-OK status (carries `.status`) | "HTTP <status>" |

There is **no retry loop in 1.6.0** — fail fast, show the error, and a re-click of the checkup
button re-runs cleanly (a re-run is a clean slate anyway). Cancellation
(`llm:checkup:cancel` / a second click while running) aborts via `AbortController` and reports
`cancelled: true` on the error event.

## 8. Guidance for future features

The harness exists so the *next* LLM feature reuses client, batching, normalization, and the
error taxonomy without re-deriving them.

- **Correction (this feature):** fast, *non-thinking* models at temperature 0 are the right
  class — one-to-one word fixes need determinism, not deliberation, and thinking output is pure
  latency. Keep `llmThinking: 'auto'` (the strip costs nothing on clean models) and the 25%
  response reserve (edits are tiny; it is headroom, not a requirement).
- **Summarization (future):** *thinking* models are welcome — the pipeline already separates
  `reasoning_content` from `content` and strips think-tags. Raise the response reserve (a
  summary is long-form, unlike a handful of edit objects) and keep batches as-is or coarser.
  Reuse `extractJson` only if you need structured output; prose answers can read `content`
  directly.
- **Non-negotiables to carry forward:** the non-destructive projection pattern (edit list +
  read-time apply, never mutate stored words), the strict edit validator's drop-don't-crash
  posture, vocabulary injected from `activeTerms()` per run, and typed errors surfaced verbatim.

## 9. Executable proof

`node tools/test-llm-harness.js` — nine passing cases against the real modules:

1. Plain model: `content` JSON → parsed and applied through a full `runCheckup` round trip
   (temperature 0, `stream: false`, stored words untouched).
2. Closed think-tag-wrapped `content` → stripped, parsed.
3. Unclosed think tag → reasoning stripped to the first JSON-like token, answer kept.
4. `reasoning_content` (+ `reasoning` alt-field) + clean `content` → parsed from content,
   reasoning captured.
5. HTTP 401 chat and 403 probe → `LLMAuthError` with the "requires an API key" message.
6. Validator drops out-of-range / whitespace-bearing / identity edits; `applyCheckup` keeps
   `t`/`d` byte-identical, honors the chunk-fingerprint drift guard, skips stale `orig`
   edits, and returns originals for `active: false` / missing block.
7. `buildBatches` on a 10k-word transcript at context 4096: contiguous ranges, every estimate
   under budget, exact 40-word preambles overlapping the previous batch.
8. `probeModels`: LM Studio `meta.context_length` extracted; OpenAI-shaped body → `null`.
9. Vocabulary against a real temp file: seeding, cross-profile case-insensitive dedupe,
   malformed-JSON fallback, `setActive` round-trip.

The test file also asserts the think-tag literals are exact codepoints at both build sites —
this repo's text tooling has mangled that literal before, so the guard is load-bearing.
