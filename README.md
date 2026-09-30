# susurroLive

> **Live, portable, multi-source transcription studio.**
> Record any mix of microphones + system audio, chunk it on the fly, transcribe chunks as they close,
> and walk away with a timecoded transcript that plays back in sync with the audio.

`susurroLive` is a **single-file, portable Windows desktop app** (Electron + a native Whisper engine)
built for one job: capture the audio happening *around* the machine — a meeting, an interview, a
session, a room — and hand back clean text, JSON-with-timecodes, and the audio itself.

---

## Why it exists

Most transcription tools do one of two things badly:

1. Record the whole thing, then make you wait at the end for a long transcription pass, or
2. Stream a single source (just the mic) and ignore everything else playing on the machine.

`susurroLive` does neither. It builds a **mix bus** from an *array of sources* (mics **and** system
loopback), **chunks the stream every N seconds**, and **transcribes each chunk the moment it closes** —
so by the time you hit Stop, the transcript is already 90% done and only the tail "catches up."

## Core capabilities

| Area | What it does |
| --- | --- |
| **Source array** | Add mic(s) + system audio (WASAPI loopback) into one stream. Mute any track from the mix. Live per-track level meters. (Per-app audio capture → v2.) |
| **Chunked capture** | Configurable chunk window (default 60 s). Each chunk is a self-contained audio file. |
| **Pause / Resume** | Pause without ending the session. Resume keeps the transcript and audio together; paused time is excluded from the timer and WAV. Stop finishes the session. |
| **Import** | Drop in any audio or video file — it is transcoded with the bundled ffmpeg into a regular session (chunks + transcript), ready to play back or export. |
| **Streaming pipeline** | Finished chunk → transcription queue → Whisper → timecoded result, all *while you keep recording*. |
| **Sessions** | Every launch is a session. Save / reopen. Loads transcript **and** audio together. |
| **Synchronized playback** | Press play → the transcript highlights and auto-scrolls word-by-word against the audio. |
| **Zero-setup** | Ships with **`small.en` bundled** (offline-ready). GPU auto-detected (CUDA) with CPU fallback + warning. |
| **Model manager** | In-app download of the rest of the catalogue (`tiny.en`, `base.en`, `medium.en`, `large-v3-turbo`, `large-v3`) with live progress, cancel, and delete. Switch models mid-session. |
| **Speakers** | After transcription, **Identify speakers** labels who spoke when (NVIDIA Nemotron-3-Diarization via NeMo-Speech.cpp, offline, up to 8 voices). Speakers are numbered by order of first speaking; optional auto-run when a session finishes. |
| **Export** | Clean `.txt`, timecoded `.json`, and the audio itself — with speaker paragraphs / per-word speakers when identified. (`.srt`/`.vtt` → v2.) |
| **Portable** | One `.exe`, no installer, no Python, no CUDA install required by the end user. |

## The look

**Warm Ink** — a dark, warm, editorial palette (ink blacks, cream paper, amber accent) with a
squares-based audio visualizer on the right rail. Portrait tablet proportions (~4:5), never
cramped. See [`docs/warm-ink-tokens.md`](docs/warm-ink-tokens.md).

The grid uses a textured, flowing lattice with smooth audio response, a directional import
current, and a still pause indicator. It respects the system's reduced-motion preference.

**v1.2:** the idle grid rotates through **eight** light fields (woven folds, ink in water, weave,
aurora curtain, ripples, ring, ember drift, tide) on per-field dwell times. Scrolling the
transcript stirs a **reading current** through the grid; imports fill with a progress wavefront
and finish with a completion sweep; every finished chunk sends a soft heartbeat down the rail.
Static film grain texture, a shimmer on transcribing chunk chips, and animated caution stripes on
the DEMO banner round it out — all reduced-motion aware. See
[`docs/v1.2-animations.md`](docs/v1.2-animations.md).

Whisper output is assembled using its original word boundaries, preserving contractions
and subword fragments (including zero-duration suffixes). This fixes app-created splits
such as `token ization` and missing endings such as `I'll` becoming `I`; it applies to
`large-v3`, `large-v3-turbo`, and the smaller models. Previously saved transcripts are
unchanged; re-import their audio to transcribe with the fix. For foreign languages, select
**auto — detect** and a multilingual model in Settings.

## Status

**Phases 0–6 are built and verified running on this machine.** Launch with `run-susurroLive.bat`.

Verified by real execution (not claims):

| Check | Result |
| --- | --- |
| App boot | window renders at 820×1040, Warm Ink, **0 page errors** |
| GPU probe | RTX 5090, sm_120, 32 GB VRAM, driver 616.56 → **accelerated** |
| Native engine | whisper.cpp built with CUDA 12.9, `ggml-cuda.dll` loaded |
| Models | `small.en` 488 MB **bundled**; `large-v3-turbo` (1.62 GB) and `large-v3` (3.10 GB) download on demand. All verified transcribing correctly on GPU |
| Transcription | real (non-demo) output on `jfk.wav`: 1.25 s small.en · 1.72 s large-v3-turbo · 2.74 s large-v3 |
| Chunking | 11 s source → 3 chunks (5.12 / 5.12 / 0.76 s) all `done` |
| Global timeline | offsets applied, monotonic, last word 10.02 s inside an 11 s recording |
| Session I/O | `session.json`, chunk WAVs, per-chunk sidecars, `full.wav` (11.00 s) |

Two bugs were found by the test suite and fixed before hand-off: chunk timestamps were being
double-offset (contradicting `session-schema.md`), and sub-second trailing chunks made whisper
hallucinate words far outside the clip. See [`docs/DEV.md`](docs/DEV.md).

Not done (deferred to v2): `.srt`/`.vtt` export, per-app capture, a resident whisper model, and
overlap-window seam reconciliation — see [`docs/PLAN.md` §3](docs/PLAN.md). Speaker diarization
has landed (post-hoc; see [`docs/adr/0005-diarization-sidecar.md`](docs/adr/0005-diarization-sidecar.md)).

**Packaged release:** v1.1.0 ships as a single portable `.exe`
(`build/susurroLive-1.1.0-portable.exe`, phase 7 complete). Only `small.en` is bundled in the
package — the NSIS payload has a hard ~2 GB ceiling, so the larger models download at runtime
(see `electron-builder.yml`). For development, the app also runs from source via
`run-susurroLive.bat`.

---

## Repository map

```
susurroLive/
├─ docs/              plan, architecture, schema, ADRs, style tokens
├─ src/
│  ├─ main/           Electron main process  (capture, pipeline, session, gpu, models)
│  ├─ preload/        contextBridge API surface
│  └─ renderer/       UI (components, theme, warm-ink.css)
├─ native/            whisper.cpp build output + sidecar binaries (gitignored)
├─ assets/            icon, brand
├─ scripts/           build/fetch/verify helper scripts
├─ tests/             unit + fixtures
└─ tools/             dev utilities (level tester, pipeline simulator)
```

## Quick start (dev)

**Windows:** double-click **`run-susurroLive.bat`** — it checks the toolchain, reports GPU/whisper
status, installs dependencies on first run, then launches the app.

Or by hand:

```bash
npm install
npm run native:whisper   # build whisper.cpp with CUDA (see docs/DEV.md for the toolkit pin)
npm run native:models    # download the default ggml model
npm run native:diarizer  # build NeMo-Speech.cpp (speaker diarization) + fetch its model
npm run dev              # launch Electron
npm run smoke            # headless boot + screenshot + diagnostics
npm run dist             # produce the portable single-file .exe
```

See [`docs/DEV.md`](docs/DEV.md) for the manual test checklist and known limitations.

## Documentation

- [`docs/PLAN.md`](docs/PLAN.md) — phased execution plan
- [`docs/v1.2-animations.md`](docs/v1.2-animations.md) — v1.2.0 plan: visualizer animations
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components & data flow
- [`docs/session-schema.md`](docs/session-schema.md) — the session JSON contract
- [`docs/audio-capture.md`](docs/audio-capture.md) — mix bus & chunker design
- [`docs/transcription-pipeline.md`](docs/transcription-pipeline.md) — chunk queue → timecoded merge
- [`docs/gpu-cuda.md`](docs/gpu-cuda.md) — detection, fallback, build archs
- [`docs/adr/`](docs/adr/) — architecture decision records

## License

Released under the [BSD 3-Clause License](LICENSE). Third-party components keep their own
licenses — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the [`licenses/`](licenses/)
folder for the full texts (whisper.cpp MIT, sherpa-onnx / NeMo-Speech.cpp Apache-2.0,
Parakeet CC-BY-4.0 © NVIDIA, Nemotron-3-Diarization OpenMDW-1.1, FFmpeg LGPL-3.0).
