# ADR 0005 — Speaker diarization: NeMo-Speech.cpp sidecar, post-hoc, turns only

- **Status:** Accepted
- **Date:** 2026-09-25
- **Plan:** `.hermes/plans/2026-09-24_000000-nemotron-diarization.md`

## Context

Users want to know *who* said what. Constraints carried over from ADR 0001/0002:

1. **Portable** — ships inside `resources/`; the end user installs nothing (no Python/PyTorch).
2. **Offline** — no cloud.
3. **Additive** — sessions without speakers behave exactly as before; the chunked transcription
   pipeline (ADR 0003) is not touched.

The capture is one mono mix of mic + system loopback (ADR 0004), so speakers must be separated
acoustically, not by channel.

## Options considered

| Option | Portable | Speakers | Verdict |
| --- | --- | --- | --- |
| **NVIDIA Nemotron-3-Diarization via NeMo-Speech.cpp** (ggml, native exe) | ✅ ~7 MB exe+DLLs + 102 MiB GGUF | up to 8 | **Chosen** |
| Sortformer 4spk-v2 via NeMo-Speech.cpp v0.1.0 prebuilt | ✅ | up to 4 | Fallback; same CLI/JSON |
| audio.cpp fork + `audio-cpp/Nemotron-3-Diarization-GGUF` | ⚠️ no Windows prebuilt | up to 8 | Rejected: GGUF format is audio.cpp-specific |
| pyannote / NeMo (Python) | ❌ PyTorch runtime | any | Rejected (portability) |

## Decision

- **Sidecar:** `nemo-speech diarize <full.wav> --model <gguf> --format json --quiet`, spawned once
  per run from `src/main/diarizer.js`. The exe lives in **`bin/diarizer/`**, not `bin/`: it ships
  `ggml*.dll` with the same names as whisper.cpp's from a different ggml revision, and Windows
  loads DLLs from the exe's folder first. The VC++ runtime is copied beside it.
- **Source build, pinned** (`97a15af`, `scripts/build-diarizer.ps1`): Nemotron-3 support landed
  on `main` after v0.1.0; the v0.1.0 prebuilt rejects the model (`pre_ln transformer variant is
  not supported`).
- **One local patch** (`scripts/patches/nemo-speech-cpu-threads.patch`): upstream hard-codes 4
  CPU compute threads; `NEMO_SPEECH_CPU_THREADS` now overrides it (default unchanged).
- **Post-hoc only.** Runs after transcription (button, or auto when the pipeline goes idle),
  over `audio/full.wav` — the chunks concatenated in index order, i.e. the global timeline, so
  turns need no offset — downsampled to 16 kHz in `temp/` first (the CLI would resample itself,
  but it holds the whole file as float32).
- **Turns only in `session.json`** (`diarization` block, `SCHEMA_VERSION` stays 1). A word's
  speaker is derived at send/export time: the turn containing the word's **start**, else the
  nearest turn within 1.0 s. Word indices are never stored, because `transcript.words` is rebuilt
  on every open/chunk and can re-index.

## Measurements (this box: Core Ultra 9 285K, RTX 5090 — CPU build)

Fixture: 10 utterances by three Windows TTS voices (two male, one female), 74.8 s, exact truth.

| Check | Result |
| --- | --- |
| Speakers found | 3 of 3; zero confusion (every attributed second went to the right voice) |
| Word attribution vs text truth | start-point rule **97.6%** · largest overlap 92.9% · midpoint 92.3% |
| 74.8 s, 4 threads (upstream) | 18–20 s |
| 74.8 s, 8 / 16 threads (patched) | 11.9 s / 8.0 s — byte-identical output |
| 48 kHz vs 16 kHz input | same speed and accuracy; same speakers over 60 min (boundaries ±0.4 s) |
| 61 min (490 turns), 48 kHz, 4 threads — upstream | **19.0 min**, 1.85 GB peak RAM, 3/3 speakers, zero confusion |
| 61 min, 16 kHz, 16 threads — patched | **7.8 min** (with other load on the box), **1.18 GB** peak, identical accuracy |
| In-app, 75 s import → labels (whisper small.en GPU + diarizer, 12 threads) | 12.9 s |

Speaker identities stayed consistent across the whole hour (streaming mode). The app now
downsamples to 16 kHz with the bundled ffmpeg before diarizing (falls back to the 48 kHz
`full.wav` if ffmpeg is unavailable) purely for the RAM saving.

**Plan target missed:** the plan asked for "an hour in ≤ ~2 min". CPU does an hour in ~8 min on
this 24-core desktop and will be slower on a laptop. It runs after transcription with the UI
responsive, shows elapsed time, and can be cancelled. A CUDA build (ggml-cuda ≈ 110 MB extra; can
borrow the CUDA 12 runtime whisper already ships) would be the next step if that is too slow —
it needs a CPU build alongside for machines without an NVIDIA GPU.

Word-attribution misses are whisper placing a sentence's last word late (inside the next
speaker's turn); no join rule can recover those without text cues.

## Consequences

**Positive** — fully offline and portable (~7 MB + 102 MiB); no new runtime dependency; the
transcription pipeline is untouched; agents reading a session folder get the join rule as a
runnable recipe in `AGENTS.md` §4.6 (cross-checked against the JS).

**Negative** — a pinned source build of an unreleased upstream commit plus one local patch to
carry until upstream ships a release with Nemotron-3 (then switch to the prebuilt and drop the
patch if upstream exposes a thread setting). Memory scales with audio length (the CLI loads the
whole file as float32). Labels are arrival order, never identities.
