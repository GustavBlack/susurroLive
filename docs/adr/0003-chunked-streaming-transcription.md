# ADR 0003 — Chunked, streaming transcription (not one-pass-at-stop)

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

Users record long sessions (meetings, interviews). A single transcription pass at Stop means the user
waits minutes after they stop. The product explicitly wants transcription to **overlap** recording so
that only the tail is left to finish.

## Decision

Split the mixed stream into **fixed windows** (`chunkSec`, default 30 s). Each window becomes a
self-contained audio file. **The moment a chunk closes, it is enqueued for transcription.** A worker
pool transcribes chunks concurrently while recording continues. Results are merged into one global
timeline via `offsetSec = index × chunkSec`.

## Consequences

**Positive**
- Perceived latency at Stop is ~the tail, not the whole session.
- Crash-safe: each chunk's status is persisted; interrupted work resumable.
- A single bad chunk doesn't poison the session (retryable).
- Chunks are individually seekable/playable.

**Negative / accepted**
- Word/sentence artifacts at chunk seams (mitigated by seam de-dup; v2 = overlap windows).
- Fixed windows assume no pause/resume; a pause mode must derive offsets from sample counts.
- Chunker must be wall-clock-driven (loopback is silent when idle) — a design constraint, not a bug.
- Redundant context per chunk (Whisper sees only its window) can cost a little accuracy vs one long
  pass. Accepted for the latency win.

## Alternatives rejected

- **One pass at Stop:** simplest, but the whole point of the app is to avoid the wait.
- **True streaming (rolling window):** lower latency but far more complex and Whisper isn't natively
  streaming; poor fit for the "chunk = file" mental model the user asked for.
