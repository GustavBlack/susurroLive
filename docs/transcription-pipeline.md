# Transcription Pipeline

The defining feature: **transcribe chunks as they close, so recording and transcription overlap.**
At Stop, only the tail remains.

## Engine

**whisper.cpp** as a sidecar (`whisper-cli.exe`), one invocation per chunk.

Why CLI-per-chunk for v1 (and not a resident model):
- Dead simple, crash-isolated, trivially parallel via process count.
- Trade-off: the model reloads per call (~0.5 s for `small.en`, ~5 s for `large-v3` on GPU).
  Acceptable against 30–60 s chunks. **v2:** a resident-model N-API/FFI wrapper to eliminate reloads.

### Invocation shape

```
whisper-cli.exe \
  -m models/ggml-small.en.bin \
  -f audio/chunk_0007.wav \
  -l en \
  --output-json --output-file transcripts/chunk_0007 \
  -ml 1 -sow       # short segments, split on whole words
  # optional: --vad ...
```

`-ml 1` alone splits on **tokens**, which are often only part of a word. `-sow` is essential:
it keeps the token pieces of contractions, long words and UTF-8 characters together. The
parser also reconstructs any remaining continuations using the model's original whitespace
before trimming text. Thus ` I` + `'m` becomes `I'm`, and ` trans` + `cription` becomes
`transcription`, with the combined chunk-local time range.

Zero-duration and shared timestamps are retained: alignment failure does not mean text is
wrong. The conservative phrase-loop guard still limits a 4–12-word phrase repeated more
than four times consecutively. Languages without word spaces retain contiguous phrases
rather than gaining artificial spaces; their highlight units can therefore be longer.

The session VAD preference does not map to `-nf`. That CLI flag disables temperature
fallback, not voice activity detection. Decoding fallback stays enabled for both VAD
preferences; real native VAD requires a separate model and is not configured here.

> Note: word-level timestamps are still labelled *experimental* upstream and can be noisy at segment
> starts. We use them for karaoke highlighting (where a few tens of ms of error is invisible), not
> for hard captioning. Fixing word reconstruction improves textual integrity; it does not
> make approximate alignment exact or eliminate model recognition errors.

### Quality validation and limits

The previous parser reproduced `i 'm`, `token ization`, `we 're`, `don 't`, and
`tr un c ated` on a synthesized English sample with `large-v3-turbo`. It also discarded
the zero-duration `'ll` from `I'll`. Re-reading the same native JSON with the corrected
parser restores all of those words. Native CUDA checks with `base.en`, `large-v3-turbo`
and `large-v3` also preserve those contractions and words with `-sow` enabled.

`node tools/test-whisper-text.js` covers these failures, punctuation, Portuguese accents,
Chinese/Japanese/Thai spacing, shared timestamps, malformed JSON, assembly offsets, exports
and the CLI flags. `node tools/test-loopguard.js` checks the retained repetition guard.
These are correctness checks, not a measured word-error-rate benchmark on real meetings.

Old session transcripts have already lost token-boundary information (and some text).
Re-transcribe their saved audio to apply the fix; do not guess missing letters in stored text.

Upstream references:
- [whisper.cpp CLI options](https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/cli.cpp):
  `--split-on-word`, maximum segment length, temperature fallback and separate VAD controls.
- [OpenAI Whisper tokenizer](https://github.com/openai/whisper/blob/main/whisper/tokenizer.py):
  subword joining and handling of languages without spaces.
- [OpenAI model guidance](https://github.com/openai/whisper#available-models-and-languages):
  model/language accuracy varies; turbo trades some accuracy for speed. Use a multilingual
  model for non-English audio, and the known spoken language where possible.

## Queue & worker pool

```
Queue  (persisted per chunk in session.json)
  pending ──► queued ──► running ──► done
                           │
                           └──► error ──(retry)──► queued
```

- **Concurrency policy**
  - `device == cuda` → **1** worker (one model in VRAM; avoids OOM).
  - `device == cpu` → `min(4, ceil(cores / 2))`.
- **Dispatch:** a free worker pulls the lowest-index `queued` chunk (FIFO by capture order).
- **Backpressure:** if the queue depth exceeds a threshold, surface "N chunks behind" and (optionally)
  raise concurrency; never silently fall behind.
- **Crash safety:** states live in `session.json`. On reopen, `running`/`queued` reset to `pending`.

## Assembly — the sync-critical step

`src/main/assemble.js` turns per-chunk output into one session timeline.

```ts
function assemble(chunk: Chunk, raw: WhisperJson): Word[] {
  const off = chunk.offsetSec;          // cumulative captured duration before this chunk
  return raw.words.map(w => ({
    t: off + w.t,                       // chunk-local → global
    d: w.d,
    w: w.w,
    chunk: chunk.index,
  }));
}
```

`offsetSec` is the **only** thing tying a chunk back to the single audio timeline. See
[`session-schema.md`](session-schema.md).

### Seam handling

Concatenating transcripts at chunk boundaries can produce artifacts (a word split across the
boundary, doubled spaces, a sentence cut in half). v1 pipeline:

1. **Reconstruct** whole words/phrases from native text, preserving original boundaries.
2. **Join** whole words with a single space; collapse runs of spaces.
3. **Heuristic de-dup:** if the last word of chunk N equals the first word of chunk N+1 and
   their timing gap is below 0.9 seconds, drop the duplicate. This is a heuristic and cannot
   distinguish every real repetition from a repeated seam word.
4. Keep **sentences** (`transcript.segments`) as contiguous index ranges into the assembled
   word list, avoiding duplicate words from overlapping timestamp ranges.

Chunk offsets use captured audio duration. A Pause can close a partial chunk, so offsets
must not be inferred by multiplying the chunk index by the configured chunk size.

> v2 upgrade path: overlapping windows (e.g. 2 s) with last-wins reconciliation, or a
> `stable-ts`-style alignment pass. Not needed to ship.

## Catch-up UX

While recording, transcribe continuously. On **Stop**:

1. Close the final partial chunk, enqueue it.
2. Show the **pipeline strip**: `done ✓ | done ✓ | running ◐ | pending · | pending ·`.
3. Show remaining count + ETA (from measured per-chunk time).
4. When drained, flip status to `complete`, enable exports.

This is the payoff: a 1-hour session usually finishes transcribing seconds after Stop, not minutes.

## Failure handling

| Failure | Action |
| --- | --- |
| whisper-cli non-zero exit | mark chunk `error`, capture stderr, offer Retry |
| CUDA OOM | retry that chunk with `--no-gpu` (CPU) |
| Malformed JSON | mark `error`, keep the audio (re-transcribable) |
| Model missing | block Start with a clear "download model" CTA |

## Outputs

- `transcripts/chunk_NNNN.json` — raw, per-chunk, chunk-local times.
- `session.json → transcript` — global timeline (words + segments + fullText).
- `exports/` — derived on demand: `.txt`, `.json`, `.srt`, `.vtt`.
