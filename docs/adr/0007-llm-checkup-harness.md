# ADR 0007 — Opt-in, non-destructive LLM transcript checkup

- **Status:** Accepted
- **Date:** 2026-10-17
- **Plan:** `.hermes/plans/2026-10-17_210840-1-6-0-llm-checkup-engine-settings.md`

## Context

ASR output contains small, fixable errors (homophones, mangled proper nouns, wrong acronyms).
Users run local or remote OpenAI-compatible endpoints (LM Studio, llama.cpp server, Ollama,
vLLM) and are willing to have their finished transcript corrected by their own model — but the
correction must never damage the pipeline's guarantees: karaoke word↔time sync, diarize-join
word starts, and the recoverable original. ADR 0005 established the post-hoc sidecar pattern;
ADR 0006 established the engine seam. This ADR fixes the data model, consent model, and gating
for the 1.6.0 "AI transcript checkup".

## Options considered

| Option | Verdict |
| --- | --- |
| **Edit list + read-time projection** (store `checkup.edits`, apply at serve/export time) | **Chosen** |
| Mutate `words[i].w` in place after the LLM answers | Rejected: destroys the original, breaks undo/compare, entangles corrections with retranscription |
| Rewrite the whole transcript via a new session block | Rejected: duplicates word data, double bookkeeping on every read path |
| Diff/patch full text and re-align words | Rejected: re-alignment risks timing corruption; one-to-one word edits make it unnecessary |

## Decision

### D1 — Non-destructive projection

Stored `session.transcript.words` are **immutable**. The checkup produces a `checkup` block:
`{ active, model, endpoint, applied, batches, at, vocabulary, chunkHashes, edits }` (persisted
in `session.json`; `MANIFEST_VERSION 5` documents it in §4.7). `applyCheckup(words, checkup)`
is the single pure projection applied at read time — the same pattern diarize-join uses to derive
speakers. The renderer payload and every export route through it (`projectedWords` in
`exporters.js`); `checkup.active` selects corrected vs original for UI and exports alike;
`discard` deletes the block; a re-run replaces the block wholesale (clean slate).

**Retranscription drift:** the block stores per-chunk FNV-1a fingerprints (`chunkHashes`). The
projection applies an edit only when the word's chunk still fingerprints identically *and* the
stored word still equals `edit.orig`; a drifted chunk's edits are dropped and its chunk id is
reported in `driftedChunkIds` for the UI's "drifted" marking. Rationale: retranscription is
rare, so whole-session fingerprints beat per-word diffing and per-chunk re-checkup UI.

### D2 — One-to-one word edits only

The model may return `{"edits":[{"i":<global word index>,"w":"<replacement>"}]}` — nothing
else. `parseEdits` strictly drops out-of-batch indices, non-string or whitespace-bearing `w`
(would split a word), and identity edits. `t`/`d` are never touchable, so karaoke and
diarize-join stay valid with zero timing migration. Add/delete/merge/reorder is explicitly out
of scope for 1.6.0; a malformed suggestion is skipped, never half-applied.

### D3 — Explicit click consent; never automatic

The checkup runs only on a click of the transcript-card button. The button is completely hidden
unless: the feature is enabled in settings AND an endpoint + model are configured AND the
pipeline is idle AND diarization has resolved. There is no auto-run, no on-by-default, no
confirmation dialog — the explicit click *is* the consent. Progress events stream per batch; a
second click while running cancels.

### D4 — Diarizer-resolution gating, failure-tolerant

A **running** diarizer blocks the checkup (the transcript is mid-mutation; mirroring the diarize
button's own gating). A **failed or unavailable** diarizer does not — the checkup is still
offered, and the prompt builder simply omits speaker tags when the session is not diarized. The
correction rules are identical for both transcript structures.

### D5 — Plain-JSON, user-owned vocabulary

Vocabulary profiles live in `<userData>/vocabulary.json` — a standalone file simple enough for
the user to edit by hand or with an external LLM tool: `{ version, profiles: [{ id, name,
active, terms }] }`, seeded with an active `default` profile. No cache (re-read on every use),
case-insensitive dedupe across active profiles, and malformed JSON degrades to an empty term
list rather than crashing a run. The block snapshots the terms used so prompts remain
auditable. Per-profile activate/deactivate serves multi-purpose machines (tech meetings vs
gaming commentary) without a heavyweight vocab editor.

### No auto-connect handholding

The user configures their own endpoint URL, model id, and optional API key — no Ollama/LM Studio
auto-discovery, no connection wizards. The only assistances are a "list models" probe
(`llm:probe`, which best-effort extracts context length, e.g. LM Studio's
`meta.context_length`) and typed, human-readable errors (401/403 → "endpoint requires an API
key — enter it in Settings"). Rationale: local endpoint topologies are the user's domain; a
wizard would guess wrong and hide real failures. Fail fast, no retry loop — a re-click re-runs.

## Consequences

- The correction pathway is read-only by construction: `applyCheckup` returns new arrays; the
  IPC layer owns persistence and never writes projected words back to disk.
- Exports and UI can never disagree: both read `projectedWords(session)`; a drifted chunk shows
  (and exports) original while the rest shows corrected — the UI view IS the export view.
- Thinking and non-thinking models both work through one normalization pipeline
  (`reasoning_content` preference → think-tag strip with JSON-like-guard → balanced-JSON
  extraction); `llmThinking: 'off'` is the per-endpoint escape hatch.
- `session.json` gains an optional `checkup` block (`SCHEMA_VERSION 2`); sessions without one
  are byte-identical to pre-1.6.0 behavior.
- Future LLM features (summarization et al.) inherit client, batching, normalization, vocabulary,
  and the error taxonomy — see `docs/llm-harness.md`.
- Executable proof: `node tools/test-llm-harness.js` (9 cases) and
  `tools/test-checkup-ipc.js` (IPC-level: stored words unchanged, toggle, discard, drift,
  concurrency guard, export/UI agreement).
