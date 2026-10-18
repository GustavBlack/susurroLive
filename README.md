# susurroLive

> **Live, portable, multi-source transcription studio.**
> Record any mix of microphones + system audio, chunk it on the fly, transcribe chunks as they close,
> and walk away with a timecoded transcript that plays back in sync with the audio.

`susurroLive` is a **Windows desktop app** (Electron + native local speech engines — no Python, no
cloud) built for one job: capture the audio happening *around* the machine — a meeting, an interview,
a session, a room — and hand back clean text, JSON with timecodes, and the audio itself.

**v1.6.0** · Windows 10/11 x64 · BSD-3-Clause · ships as an installer **or** a single portable `.exe`

---

## Why it exists

Most transcription tools do one of two things badly:

1. Record the whole thing, then make you wait at the end for a long transcription pass, or
2. Stream a single source (just the mic) and ignore everything else playing on the machine.

`susurroLive` does neither. It builds a **mix bus** from an *array of sources* (mics **and** system
loopback), **chunks the stream every N seconds**, and **transcribes each chunk the moment it closes** —
so by the time you hit Stop, the transcript is already 90% done and only the tail "catches up."

## Install

Grab the latest from **[Releases](https://github.com/GustavBlack/susurroLive/releases/latest)**:

| Artifact | Use it when |
| --- | --- |
| `susurroLive-Setup-<version>.exe` | **Recommended.** Assisted per-user install (no UAC, choose directory + shortcuts), uninstallable, and it can update itself in place. |
| `susurroLive-<version>-portable.exe` | Zero-install single file — run it from a USB stick. No update feed. |

Everything the app needs at runtime is inside the package: the speech engine, its CUDA runtime,
`ffmpeg`, and the default `small.en` model. English works out of the box, offline, with no separate
CUDA or Python install.

- **GPU is optional.** If an NVIDIA GPU is present it is auto-detected and used (CUDA); otherwise the
  app runs on CPU and says so.
- **Sessions survive uninstall.** Sessions and settings live in `%APPDATA%\susurroLive` and are never
  deleted by the installer or an update.
- **Updates are consent-first.** Installed builds check GitHub Releases for a newer version
  (`latest.yml`), show a pill in the header when one exists, download only when you click it, and
  install on quit. Settings → About → **Check for updates** does a manual check any time.

## Core capabilities

| Area | What it does |
| --- | --- |
| **Source array** | Add mic(s) + system audio (WASAPI loopback) into one stream. Mute any track from the mix. Live per-track level meters. (Per-app audio capture → v2.) |
| **Chunked capture** | Configurable chunk window (default 60 s). Each chunk is a self-contained audio file. |
| **Pause / Resume** | Pause without ending the session. Resume keeps the transcript and audio together; paused time is excluded from the timer and WAV. Stop finishes the session. |
| **Import** | Drop in any audio or video file — it is transcoded with the bundled `ffmpeg` into a regular session (chunks + transcript), ready to play back or export. |
| **Streaming pipeline** | Finished chunk → transcription queue → local engine → timecoded result, all *while you keep recording*. |
| **Two engines** | **Whisper** (whisper.cpp, GPU-accelerated) or **Parakeet** (sherpa-onnx int8, English) — chosen in Settings, with per-engine model lists. See [Engines](#engines). |
| **Sessions** | Every launch is a session. Save / reopen. Loads transcript **and** audio together. |
| **Synchronized playback** | Press play → the transcript highlights and auto-scrolls word-by-word against the audio. |
| **Zero-setup** | Ships with **`small.en` bundled** (offline-ready). GPU auto-detected (CUDA) with CPU fallback + warning. |
| **Model manager** | In-app download of the rest of the whisper catalogue (`tiny.en`, `base.en`, `medium.en`, `large-v3-turbo`, `large-v3`) with live progress, cancel, and delete. Switch models mid-session. |
| **AI transcript checkup** | *Opt-in, never automatic*: send a finished transcript to **your own** OpenAI-compatible endpoint and let a local model fix small recognition errors — without mutating the transcript. See [AI transcript checkup](#ai-transcript-checkup-opt-in). |
| **Speakers** | After transcription, **Identify speakers** labels who spoke when (NVIDIA Nemotron-3-Diarization via NeMo-Speech.cpp, fully offline). Speakers are numbered by order of first speaking; optional auto-run when a session finishes. |
| **Export** | Clean `.txt`, timecoded `.json`, and the audio itself — with speaker paragraphs / per-word speakers when identified. Exports mirror exactly what you see (checked or original). (`.srt`/`.vtt` → v2.) |
| **Themes** | 11 built-in themes, each with a dark and a light variant, swapped with an animation. |
| **Agent-ready sessions** | Every session folder carries an `AGENTS.md` with the folder map and the `session.json` schema, so any coding agent can read a session without guessing. |
| **Portable** | Installer or one `.exe`. No Python, no CUDA install, no cloud account. |

## Engines

Two peer engines sit behind one selector in Settings, and the model list follows the selected
engine instead of silently doing nothing:

- **Whisper** (default) — whisper.cpp with CUDA. The catalogue runs `tiny.en` → `large-v3`
  (multilingual models included); `small.en` is bundled, everything else downloads on demand.
- **Parakeet** — sherpa-onnx int8, English, fast on modest hardware. Selecting it offers a one-time
  in-app set-up (**~23 MB** engine + **~487 MB** model) with progress; it is provisioned into your
  app data rather than bundled.

Routing is per call, so a session started with one engine can be continued with the other — every
chunk records which engine actually produced it.

## AI transcript checkup (opt-in)

An optional post-transcription pass that sends the finished transcript to an **OpenAI-compatible
endpoint you configure** — LM Studio, Ollama, llama.cpp server, vLLM, or anything else speaking that
API — and lets a local model correct small ASR errors.

- **Never automatic.** Off by default; the button stays invisible until you enable the feature in
  Settings and set an endpoint + model. Click to run, click again to cancel.
- **Non-destructive by construction.** Words on disk are never mutated. Corrections are stored as a
  per-session edit list and applied as a read-time projection, so a per-session
  **Checked | Original** toggle switches the transcript view *and every export* between corrected
  and original. **Discard corrections** removes them entirely.
- **Timestamps untouched.** Only one-to-one word substitutions are accepted — edits that would add,
  remove, or reorder words are dropped by the validator — so karaoke sync and speaker joins stay
  exact.
- **Re-transcription safe.** Each chunk stores a word fingerprint at checkup time; if a chunk is
  re-transcribed later, only that chunk's stale edits are dropped (badged as drifted) and the rest of
  the session stays corrected.
- **Vocabulary profiles.** A plain, hand-editable `vocabulary.json` in the app data folder holds
  activatable term profiles (seeded with a `Default` profile) that are injected into the prompt.
- **Thinking models handled.** Responses are normalized across plain models, `reasoning_content`
  (LM Studio / vLLM style), and literal thinking blocks — the full contract is in
  [`docs/llm-harness.md`](docs/llm-harness.md).

Nothing new is bundled and nothing leaves your machine unless you configure an endpoint: the
transcript goes only to the server you pointed the app at.

A running diarizer blocks the checkup (GPU contention); a failed or unavailable one does not. API-key
errors surface as "endpoint requires an API key — enter it in Settings."

## The look

A portrait tablet layout (~4:5, 820×1040) with a squares-based audio visualizer on the right rail,
never cramped.

- **11 themes**, each with dark and light variants: Susurro Warm (default), Obsidian, Midnight,
  Forest, Nord, Amethyst, Crimson, Deep Teal, True Black, Desert, Tokyo Night. Pick from the dropdown
  in the header; the swap is animated and the visualizer re-tints with the theme. Tokens live in
  [`docs/warm-ink-tokens.md`](docs/warm-ink-tokens.md).
- The grid is a textured, flowing lattice with smooth audio response, a directional import current,
  and a still pause indicator. The idle grid rotates through twelve procedural light fields on a dwell
  schedule, randomized per launch so it never opens the same way twice. Scrolling the transcript
  stirs a reading current through the grid; every finished chunk sends a soft heartbeat down the rail.
- All of it respects the system's reduced-motion preference.

Whisper output is assembled using its original word boundaries, preserving contractions and subword
fragments (including zero-duration suffixes). This fixes app-created splits such as `token ization`
and missing endings such as `I'll` becoming `I`. For foreign languages, select **auto — detect** and
a multilingual model in Settings.

## Status

**v1.6.0 is built, verified, and published** — installer + portable + update feed. Verified by real
execution on this machine, not claims:

| Check | Result |
| --- | --- |
| Test suite | 9/9 suites green: engine, pipeline, session manifest, import, exporters, visualizer, LLM harness (9 cases), checkup IPC, parakeet engine (SKIP when unprovisioned) |
| App boot | window renders at 820×1040, **0 page errors**; dev **and** packaged `--smoke` pass |
| Packaged smoke | exercises the real installed payload: bundled model, `resources/bin` engine, GPU probe, update check |
| GPU probe | RTX 5090, sm_120, 32 GB VRAM, driver 617.42 → **accelerated** (Blackwell via whisper.cpp CUDA arch 120) |
| Native engine | whisper.cpp built with CUDA 12.9, `ggml-cuda.dll` loaded; CPU fallback path exercised |
| Models | `small.en` 488 MB **bundled**; `large-v3-turbo` (1.62 GB) and `large-v3` (3.10 GB) download on demand — all transcribe correctly on GPU |
| Transcription | real (non-demo) output on `jfk.wav`: 1.25 s small.en · 1.72 s large-v3-turbo · 2.74 s large-v3 |
| Chunking / timeline | 11 s source → 3 chunks (5.12 / 5.12 / 0.76 s), offsets applied once, monotonic, last word inside the recording |
| Session I/O | `session.json` + embedded JSON Schema, chunk WAVs, per-chunk sidecars, `full.wav`, `AGENTS.md` |

Not done yet (deferred to v2): `.srt`/`.vtt` export, per-app audio capture, a resident whisper model,
and overlap-window seam reconciliation — see [`docs/PLAN.md` §3](docs/PLAN.md). Speaker diarization
has landed (post-hoc; see [`docs/adr/0005-diarization-sidecar.md`](docs/adr/0005-diarization-sidecar.md)).

## Requirements

- **Windows 10 or 11, x64.** No Python, no CUDA toolkit, no separate FFmpeg.
- **~3 GB free disk** for the install (the CUDA runtime + `small.en` dominate). Extra ggml models are
  another 0.1–3 GB each, downloaded on demand.
- **NVIDIA GPU optional** — used automatically when present (CUDA 12.9 runtime included). Otherwise
  the app runs on CPU with a visible warning.

---

## Repository map

```
susurroLive/
├─ docs/              plan, architecture, schema, ADRs, per-release notes
├─ src/
│  ├─ main/           Electron main: capture, engines, pipeline, session, gpu, llm, updater
│  ├─ preload/        contextBridge API surface
│  ├─ renderer/       UI (components, theme/, visualizer, styles)
│  └─ shared/         code shared across processes
├─ native/            engine build output + sidecar binaries (gitignored — fetched by npm scripts)
├─ assets/            icon, brand
├─ scripts/           build / fetch / verify helper scripts
├─ tests/             unit tests + fixtures
└─ tools/             test harnesses + dev utilities (engine, pipeline, smoke, inspectors)
```

## Quick start (from source)

Requires **Node.js 20+** and PowerShell (the native setup scripts are PowerShell).

```bash
npm install
npm run native:whisper   # fetch/build whisper.cpp + CUDA (see docs/DEV.md for the toolkit pin)
npm run native:models    # download the default ggml model
npm run native:diarizer  # build NeMo-Speech.cpp (speaker diarization) + fetch its model
npm run dev              # launch the app
npm run smoke            # headless boot + screenshot + diagnostics
npm run dist             # produce the installer, portable exe, and update feed
```

`native:whisper` is the CUDA build; a CPU-only build script sits in `scripts/_build-whisper-cpu.bat`.
Nothing under `native/` is committed — it is fetched or built locally.

### Verify it actually works

The interesting tests drive the real engine, not mocks:

```bash
node tools/test-engine.js            # real transcription on a known clip
node tools/test-pipeline.js          # chunker → queue → engine → global timeline offsets
node tools/test-import.js            # decode media, mux + import round trip
node tools/test-exporters.js         # txt/json/audio projections (incl. speakers)
node tools/test-llm-harness.js       # LLM checkup prompt + normalization contract
node tools/test-checkup-ipc.js       # full checkup IPC round trips (drift, exports, discard)
node tools/test-updater-stub.js      # update state machine + payload serialization
node tools/test-viz.js               # visualizer determinism + frame budget
```

See [`docs/DEV.md`](docs/DEV.md) for the manual checklist and known limitations.

## Documentation

- [`docs/DEV.md`](docs/DEV.md) — dev guide, manual test checklist, known limitations
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components & data flow
- [`docs/PLAN.md`](docs/PLAN.md) — phased execution plan and what's deferred
- [`docs/session-schema.md`](docs/session-schema.md) — the session JSON contract
- [`docs/audio-capture.md`](docs/audio-capture.md) — mix bus & chunker design
- [`docs/transcription-pipeline.md`](docs/transcription-pipeline.md) — chunk queue → timecoded merge
- [`docs/gpu-cuda.md`](docs/gpu-cuda.md) — detection, fallback, build archs
- [`docs/installer.md`](docs/installer.md) — installer, portable target, and the update feed
- [`docs/llm-harness.md`](docs/llm-harness.md) — AI checkup harness: prompt shape, batching, normalization, per-server quirks
- [`docs/warm-ink-tokens.md`](docs/warm-ink-tokens.md) — design tokens
- [`docs/adr/`](docs/adr/) — architecture decision records
- Per-release notes: `docs/v<version>-<slug>.md`

## Contributing

This is a personal project and **does not accept pull requests.** Issues with a clear reproduction
are welcome, and **forks are encouraged** (BSD-3-Clause, see below).

## License

Released under the [BSD 3-Clause License](LICENSE) © Gustav L. Third-party components keep their own
licenses — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the [`licenses/`](licenses)
folder for the full texts (whisper.cpp MIT, sherpa-onnx / NeMo-Speech.cpp Apache-2.0,
Parakeet CC-BY-4.0 © NVIDIA, Nemotron-3-Diarization OpenMDW-1.1, FFmpeg LGPL-3.0).
