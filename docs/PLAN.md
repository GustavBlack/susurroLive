# susurroLive — Execution Plan

> **Implementation status (2026-09-22):** **v1.1.0 is shipped** — Phases 0–7 are complete,
> including the portable single-`.exe` package (`build/susurroLive-1.1.0-portable.exe`).
> See [`DEV.md`](DEV.md) for how to run it and what to test by hand. Three deviations from this
> plan are recorded in DEV.md § "Deviations": the app ships as plain JS (no bundler/TS), capture
> uses Electron's own getUserMedia + desktopCapturer loopback instead of a native module, and
> session validation is a hand-rolled validator instead of zod.
>
> Shipped beyond the original plan: **pause/resume** (chunk-exact, paused time excluded) and
> **media import** (any audio/video file → a regular session via bundled ffmpeg, see
> `src/main/importer.js`).

**Goal:** a portable, single-file Windows app that records a multi-source mix, transcribes it in a
streaming (chunk-by-chunk) pipeline, stores everything in a reopenable session, and plays back the
audio with a word-synced transcript.

This document is the living plan. Update it as decisions land.

---

## 1. The one-sentence architecture

> **Electron (UI + orchestration)** + a **native capture layer** (WASAPI loopback + mic → mix bus)
> + a **whisper.cpp sidecar** (CUDA/CPU) fed by a **chunk queue**, all persisted as a **session
> folder** on disk.

```
 ┌─────────────── Electron main (Node) ────────────────┐
 │                                                       │
 │  Capture layer ──► Mix Bus ──► Chunker ──► audio/*.wav│
 │       │               │             │                 │
 │   per-track       (sum of        (every N s)          │
 │   levels          unmuted)                            │
 │                       │             ▼                 │
 │                       │        Pipeline Queue ──► whisper.cpp sidecar (CUDA/CPU)
 │                       │             │                     │
 │                       │             ▼                     ▼
 │                       │        transcripts/*.json (timecoded, offset-shifted)
 │                       │             │
 │                       └── levels ───┴──► IPC ──► Renderer (UI)
 │                                                       │
 │  Session layer  ◄── session.json (source of truth) ───┘
 └───────────────────────────────────────────────────────┘
```

---

## 2. Locked decisions (v1)

| Decision | Choice | Why |
| --- | --- | --- |
| Shell | **Electron** | Modern CSS/JS UI, animations, easy native-module + child-process access. |
| Distribution | **electron-builder `portable` target** | True single `.exe`, no installer, honors the portability requirement. |
| Transcription engine | **whisper.cpp** (`whisper-cli` sidecar) | Single native binary, first-class CUDA **and** CPU fallback, word-level timestamps, VAD, no Python. |
| Default model | **`small.en`** (ggml, 466 MiB) — **bundled in the EXE** | Best quality/speed knee for English; ships offline-ready. |
| Multilingual model | **`large-v3-turbo`** (1.5 GiB) | Best quality-per-VRAM; **downloaded on demand**. |
| Capture | **`native-audio-node`** (WASAPI) as primary, raw WASAPI N-API fallback | Prebuilt binaries, mic + system loopback + per-process, zero build deps. |
| Chunk window | **60 s default** (per-session override in UI) | Fewer files, more context per Whisper pass. |
| Chunk format | **WAV 48 kHz** (whisper.cpp resamples internally) | Lossless, trivially seekable, no resampler in our hot path. |
| Sync model | **Chunk offset + global word timeline** | Each chunk's words are shifted by `index × chunkSec`. |
| Window | **820 × 1040** (~4:5 portrait tablet) | "Vertical but not too narrow." |

Rationale for each is recorded in [`adr/`](adr/).

---

## 3. Decisions (locked 2026-09-12)

1. **Default model** → **`small.en`**.
2. **Model delivery** → **bundle `small.en` inside the single EXE** (offline out of the box, +~470 MB);
   `large-v3-turbo` and friends are download-on-demand.
3. **Chunk window** → **60 s** default, overridable per session in the UI.
4. **Worker concurrency** → auto policy: GPU = 1 worker, CPU = `min(4, cores/2)`.
5. **v1 extras** → **VAD only**. `.srt`/`.vtt`, per-app capture, and speaker diarization are **v2**.
6. **Window** → **820 × 1040** (~4:5), resizable, min ≈ 680 × 880.

> Consequence of (2): the packaged EXE grows by the model size (~470 MB). Acceptable per the
> portability goal. Export set for v1 is therefore **`.txt` + `.json` + audio** (no subtitles yet).

### Deferred to v2
- `.srt` / `.vtt` subtitle export
- Per-app audio capture (one PID per stream — see `adr/0004`)
- ~~Speaker diarization~~ — landed post-hoc (offline, after transcription): `adr/0005`,
  plan in `.hermes/plans/2026-09-24_000000-nemotron-diarization.md`. Live (streaming)
  speaker colours remain a v2.5 candidate.
- Resident-model wrapper (removes per-chunk reload)
- Overlap-window seam reconciliation

### v1.2.0 — visualizer animations (planned)
Scope, research synthesis, and phases live in [`v1.2-animations.md`](v1.2-animations.md):
more idle fields with per-field choreography, a scroll-reactive "reading current",
progress-aware import animation + chunk pulses, and restrained CSS pattern accents.

---

## 4. Phases

### Phase 0 — Scaffolding (this pass)
- [x] Repo skeleton, docs, ADRs, session schema, warm-ink tokens
- [x] Library selection + risk notes
- [x] `npm init`, wire Electron + TypeScript + electron-builder
- [x] `npm run dev` opens an empty warm-ink window at 4:5

### Phase 1 — Native engine bring-up
- [x] `scripts/build-whisper.ps1`: fetch whisper.cpp, CMake build with `GGML_CUDA=1`,
      arch list `75;80;86;89;120` (covers Pascal→Blackwell incl. the RTX 5090).
- [x] `scripts/verify-gpu.ps1`: `nvidia-smi` probe → emits JSON `{vendor,model,cuda,compute}`.
- [x] `scripts/fetch-models.ps1`: pull `small.en` (+ optional `large-v3-turbo`).
- [x] Smoke test: transcribe a known fixture WAV, assert word timestamps present.

### Phase 2 — Capture layer
- [x] Enumerate devices (mic + loopback) into a picker model.
- [x] Mix bus: N sources → summed PCM ring buffer @ 48 kHz; per-source gain + mute.
- [x] Per-source level metering (RMS/peak) emitted at ~30 Hz for the visualizer.
- [x] Chunker: roll the mix into a new `wav` file every `chunkSec`; emit `chunk:closed`.

### Phase 3 — Streaming transcription pipeline
- [x] Queue with states `pending → queued → running → done|error`, persisted per chunk.
- [x] Worker pool spawning `whisper-cli --json --output-json` per chunk.
- [x] `assemble.ts`: shift chunk words by `index × chunkSec`, append to global timeline.
- [x] "Catch-up" UX: on Stop, drain queue; show remaining count + ETA.
- [x] Backpressure + error retry (chunk can be re-queued).

### Phase 4 — Session system
- [x] Session folder layout + `session.json` writer (atomic, debounced).
- [x] Schema validation (zod) with migration hook (`version` field).
- [x] Session browser: list / open / rename / delete / reveal in Explorer.

### Phase 5 — UI (warm ink)
- [x] Layout shell (header / transport / source array / transcript / right-rail visualizer / pipeline strip).
- [x] Animated add-source rows; record button animation; equalizer squares.
- [x] Transcript view with word-level karaoke highlight + auto-scroll.
- [x] Settings panel (model, language, chunk, device, concurrency, VAD, folder).
- [x] GPU status banner (accelerated vs CPU-warning).

### Phase 6 — Playback & export
- [x] Synchronized playback (seek → highlight → scroll).
- [x] Export: `txt` (clean), `json` (timecoded), `srt`/`vtt`, audio (wav/flac/mp3 via ffmpeg).
- [x] Export progress + destination picker.

### Phase 7 — Package ✅
- [x] electron-builder portable config, `extraResources` for `native/`, `asar.unpack` for `.node`.
      Only `small.en` is bundled — the NSIS portable payload has a hard ~2 GB ceiling
      (`failed creating mmap of ...nsis.7z`), so larger models download at runtime.
- [x] First-run model provisioning + progress UI (in-app model manager with live progress,
      cancel, delete).
- [x] Packaged output: `build/susurroLive-1.1.0-portable.exe`.

---

## 5. Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| WASAPI loopback emits nothing when silent | Gaps in chunks / drift | Use `emitSilence:true`; drive chunk boundaries off a wall-clock timer, not data arrival. |
| Chunk-boundary word splits | Slightly mangled words at seams | Accept for v1; optionally overlap windows (v2). |
| Model reload cost per CLI call (~0.5–5 s) | Wasted GPU time | v1 accept; v2 = resident model via N-API/FFI wrapper. |
| Blackwell (sm_120) not in prebuilt CUDA | GPU falls back to CPU silently | Explicit `CMAKE_CUDA_ARCHITECTURES` incl. `120`; verify with smoke test. |
| Native `.node` inside ASAR | Module fails to load | `asar.unpack` + `extraResources`; path via `process.resourcesPath`. |
| Long sessions (hours) | Memory / disk growth | Stream to disk, cap in-memory transcript buffer, clean `temp/`. |

---

## 6. Definition of done (v1)

A user on a clean Windows 10/11 machine can:
1. Drop the single `.exe` anywhere and run it.
2. Pick a session folder, add a mic + system audio, mute one, see both meters move.
3. Record, watch chunks close and transcripts appear *during* recording.
4. Stop, watch the tail catch up.
5. Reopen the session later, press play, and watch the transcript follow the audio.
6. Export `.txt`, `.json`, and the audio (`.srt`/`.vtt` are deferred to v2 — see §3).
7. Do all of the above with **no** Python, Node, or CUDA installed.
