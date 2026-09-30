# ADR 0001 — Transcription engine: whisper.cpp

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

We need an engine that satisfies four hard constraints simultaneously:
1. Runs on **any** target machine with a **portable, single-file** app.
2. Uses **CUDA** when an NVIDIA GPU is present, with a **CPU fallback**.
3. Emits **word-level timestamps** (for karaoke playback sync).
4. Adds **no runtime dependency** the user must install (no Python, no CUDA toolkit, no Node).

## Options considered

| Engine | Portable binary | CUDA | CPU | Word timestamps | No-runtime-dep | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **whisper.cpp** | ✅ native exe | ✅ first-class | ✅ | ✅ (`-ml 1`) | ✅ | **Chosen** |
| faster-whisper (CTranslate2) | ⚠️ Python → PyInstaller | ✅ (bundled cuBLAS/cuDNN) | ✅ | ✅ | ✅ but ~660 MB & fragile | Runner-up |
| openai/whisper (PyTorch) | ❌ | ✅ | ✅ | ✅ | ❌ | Rejected |
| Vosk | ✅ | ❌ | ✅ | ⚠️ | ✅ | Quality too low |
| Cloud APIs | n/a | n/a | n/a | ✅ | ❌ (needs net + keys) | Rejected (offline/portable) |

## Decision

**whisper.cpp**, invoked as a `whisper-cli` sidecar process, one call per chunk.

## Consequences

**Positive**
- One static-ish native binary; encodes CUDA + CPU in one artifact.
- Word timestamps and VAD available out of the box.
- Crash isolation (a sidecar crash can't take down the UI).
- Swappable: the pipeline talks JSON, not a specific engine.

**Negative**
- Model reloads per invocation (~0.5–5 s) — mitigated by chunk sizes; v2 = resident-model wrapper.
- CUDA builds need explicit arch flags (see ADR-adjacent note in `gpu-cuda.md`) or the GPU is
  silently ignored.
- We ship/verify a native binary per release.

## Follow-ups

- v2: resident-model N-API/FFI wrapper to remove per-chunk reload.
- Evaluate `large-v3-turbo` as the multilingual default once benchmarked on studio hardware.
