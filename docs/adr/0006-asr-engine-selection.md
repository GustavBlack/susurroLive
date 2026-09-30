# ADR 0006 — Swappable ASR engine seam; Parakeet via sherpa-onnx

- **Status:** Accepted
- **Date:** 2026-09-27
- **Plan:** `.hermes/plans/2026-09-27_051533-parakeet-engine-option.md`

## Context

Parakeet (NVIDIA NeMo TDT 0.6b v3, 25 European languages) is a fast, accurate ASR model the user
wants to try against whisper.cpp. The transcription pipeline already talks to the engine through a
single seam — `engine.transcribe(audioPath, opts) → {engine, words[{t,d,w}], text, language}` —
and speaker diarization (ADR 0005) is post-hoc over `audio/full.wav`, reading only word start
times. Nothing in capture, chunking, diarization, sessions, or playback is engine-coupled.

Constraints carried forward:

1. **Portable** — a new engine must be a sidecar process; no Python/PyTorch, no Node addon.
2. **Offline** — models download on demand, never phone home.
3. **Karaoke** — every admitted engine must produce word-level timestamps.
4. **The ~2 GB portable NSIS ceiling** — a GB-scale model must not silently join the bundle.

## Options considered

| Option | Portable | Word timing | Verdict |
| --- | --- | --- | --- |
| **sherpa-onnx offline CLI** (`sherpa-onnx-offline.exe`, int8 NeMo transducer) | ✅ prebuilt win-x64 | ✅ per-token timestamps + durations (TDT-native) | **Chosen** |
| `sherpa-onnx-node` Node addon (in-process ONNX runtime) | ✅ | ✅ | Rejected: couples GPU/ONNX crash blast radius to the UI process; fights the no-bundler plain-JS setup |
| onnxruntime-node + custom decode loop | ⚠️ | DIY greedy TDT decode | Rejected: reinvents what sherpa-onnx ships |
| Parakeet via Python/NeMo | ❌ PyTorch runtime | ✅ | Rejected (portability, per ADR 0005 precedent) |

## Decision

- **Engine selector seam.** `src/main/engines/index.js` routes `transcribe()` to whisper.cpp or
  Parakeet per the `engine` setting. The pipeline's call site (`pipeline.js:132`) is unchanged;
  `chunk.engine` already records which engine produced each chunk, so mixed-engine sessions are
  valid by construction. A session does not lock to one engine.
- **Parakeet = sidecar CLI.** `sherpa-onnx-offline.exe` lives in `native/bin/sherpa/` (packaged:
  `resources/bin/sherpa/`), model files in `native/models/sherpa/`
  (`sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`: encoder/decoder/joiner int8 ONNX + tokens.txt).
  Found → available; missing → the engine reports a DEMO-style reason and whisper keeps working.
  Search order mirrors `diarizer.js`: packaged bin dir → repo `native/bin/sherpa` →
  `SUSURRO_SHERPA` env override → PATH.
- **16 kHz mono feed.** Chunks are resampled with the bundled ffmpeg (the same step diarization
  uses before feeding its model).
- **Word reconstruction.** sherpa-onnx emits BPE subword tokens with timestamps and durations;
  `engines/parakeet.js` joins them into words on token-leading whitespace, preserving the
  whisper.js word-guard semantics (keep zero-duration words, drop words beyond chunk duration).
- **Per-chunk, engine-tagged.** `chunk.engine` widens to include `parakeet`; the session JSON
  needs no schema-version bump (the field was already free-form string, additive only).
- **Packaging is a per-release decision.** The exe + ONNX runtime DLLs (~25–50 MB) and the
  ~465 MB int8 model are NOT bundled in 1.3.0. Dev machines provision via
  `scripts/fetch-parakeet.ps1`. A future release may bundle after re-running the NSIS ~2 GB
  payload check.

## Consequences

- Diarization is untouched: it reads `full.wav` + word times, never the engine.
- Karaoke works for both engines; whisper keeps `-sow` word splitting, Parakeet gets BPE joins.
- Failure isolation holds: a Parakeet/ONNX crash marks one chunk `error`, retry re-runs it.
- The Settings drawer gains an engine picker (disabled with reason when Parakeet is absent).
- Mixed `chunk.engine` values inside one session are expected, not a defect.
