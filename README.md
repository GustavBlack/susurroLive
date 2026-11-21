# susurroLive

> **Live, portable, multi-source transcription studio.**
> Record any mix of microphones + system audio, chunk it on the fly, transcribe chunks as they close,
> and walk away with a timecoded transcript that plays back in sync with the audio.

`susurroLive` is a **Windows desktop app** (Electron + native local speech engines — no Python, no
cloud) built for one job: capture the audio happening *around* the machine — a meeting, an interview,
a session, a room — and hand back clean text, JSON with timecodes, and the audio itself.

**v1.9.0** · Windows 10/11 x64 · BSD-3-Clause · ships as an installer **or** a single portable `.exe`

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
| **The look** | Tech Moca: graphite console, greige ink, condensed chrome. Dark and light, one palette, no blue. |
| **Agent-ready sessions** | Every session folder carries an `AGENTS.md` with the folder map and the `session.json` schema, so any coding agent can read a session without guessing. |
| **Agent control (MCP)** | Optional local MCP server: an agent can start/stop recordings, choose the session folder, add mic/system sources by profile, wait for transcription, and read/export the transcript. Loopback + bearer token; see [Agent control (MCP)](docs/mcp.md). |
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

## Agent control (MCP)

susurroLive 1.7 embeds a local **MCP server** at `http://127.0.0.1:8790/mcp`. When the app is
open, Hermes Agent (or any MCP client) can record and retrieve transcripts without launching a
second process:

- `recording_start` with `parentDir` + `name` creates the session folder and starts capture.
- `profile: "meeting"` adds the default microphone **and** system loopback; `voice` adds only
  the mic; `system` adds only loopback; `custom` takes an explicit source array.
- `recording_stop {waitForTranscription:true}` finalizes the session and drains the chunk queue.
- `transcript_get` returns prose or timecoded words; `export_run` writes `.txt` / `.json` / audio.

**Security:** loopback-only bind, bearer token in `%APPDATA%\susurroLive\mcp.json`, Host/Origin
checks, 1 MiB request cap. Disable in Settings → Agents (MCP).

Two client paths:

- **Native MCP:** paste the generated `mcp_servers` YAML into Hermes config; tools appear as
  `mcp_susurro_*`.
- **Skill, no MCP registration:** install `integrations/hermes/susurro-live-mcp/` (skill name
  `susurro-live-mcp` — the `-mcp` suffix keeps it distinct from any `susurro-live` source-dev
  skill, since two skills with the same name cannot both load); it launches the
  app and calls the same endpoint through `scripts/susurro.ps1` (native Windows only).

Full setup and tool reference: [`docs/mcp.md`](docs/mcp.md). Decision record:
[`docs/adr/0008-mcp-agent-control.md`](docs/adr/0008-mcp-agent-control.md).

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

**Tech Moca**: graphite console, greige ink, condensed chrome. A calm, technical, dark-first
look for a tool you work in all day. The layout is a portrait tablet (~4:5, 820×1040) with a
squares-based audio visualizer on the right rail, never cramped.

- **Tech Moca is the base, dark and light.** Dark is the default; light is greige paper with ink
  chrome. The base accent is off-white; the only warmth is the sand focus token; status is always a
  word on its own well. No gradients, no glow. Tokens live in
  [`src/renderer/theme/tech-moca.css`](src/renderer/theme/tech-moca.css).
- **The 11 earlier themes return as skins**, not as a second design: Susurro Warm, Obsidian,
  Midnight, Forest, Nord, Amethyst, Crimson, Deep Teal, True Black, Desert, Tokyo Night. A skin
  retints accent, status, chart and speaker colours only; the floor, type, spacing, radius and
  motion stay locked. The picker is in Settings → Appearance; the contrast gate is
  [`tools/check-skins.js`](tools/check-skins.js). See
  [`docs/v1.8.0-tech-moca-redesign.md`](docs/v1.8.0-tech-moca-redesign.md).
- **The window is frameless with Tech Moca controls.** The header is the drag strip; minimize,
  maximize/restore and close are drawn in the same hairline pill language as the rest of the chrome.
  Edge resize, snap and Win+arrow still work.
- **The app icon is the yellow cube mark**, built as a multi-size `.ico` from the raw artwork
  (`tools/make-icon.js`); the same mark is the header brand.
- **Settings is a floating window with tabs** (Engine, Transcription, Appearance, AI checkup,
  Agents, About), not a long drawer. Escape closes it and focus returns to the Settings button.
- The grid is a flat, flowing lattice with smooth audio response, a directional import current,
  and a still pause indicator. The idle grid rotates through twelve procedural light fields on a
  dwell schedule, randomized per launch so it never opens the same way twice. Scrolling the
  transcript stirs a reading current through the grid; every finished chunk sends a soft heartbeat
  down the rail.
- All of it respects the system's reduced-motion preference.

Whisper output is assembled using its original word boundaries, preserving contractions and subword
fragments (including zero-duration suffixes). This fixes app-created splits such as `token ization`
and missing endings such as `I'll` becoming `I`. For foreign languages, select **auto · detect** and
a multilingual model in Settings.

## Status

**v1.9.0 is built and verified on this machine.** It is Phase II of the Tech Moca redesign: the 11
earlier themes return as chroma-only skins, the window is frameless with Tech Moca controls, and the
app icon is the yellow cube mark. Phase I (v1.8.0) is the base design. Verified by real execution,
not claims:

| Check | Result |
| --- | --- |
| App boot | window renders at 820×1040, **0 page errors**; dev `--smoke` passes |
| Smoke | floating settings geometry and 6 tabs, tab switching, arrow-key navigation, Escape/focus return, dark/light persistence, skin swap + persistence in both modes, frameless chrome (drag strip, minimize, maximize/restore), engine-first model list, checkup gating, minimum-window scroll check |
| Visualizer | 31/31 checks green with the Tech Moca palette and flat tiles; the canvas follows the active skin |
| Skins | 11 skins × 2 modes pass the contrast gate (`tools/check-skins.js`); chroma-only, no layout movement |
| UI | Tech Moca tokens; skins retint accent, status, chart and speaker colours; no gradients or glow |
| Window | frameless with Tech Moca controls; maximize/restore and minimize verified in the smoke |
| Icon | multi-size `.ico` from the raw artwork; header brand uses the 32 px mark |
| Minimum window | 671×852 inner, `document.scrollWidth == innerWidth` |
| Settings | 6 tabs, arrow-key navigation, Escape closes, focus returns to the Settings button |
| Unchanged | engine, pipeline, session I/O, import, exporters, LLM harness and MCP behaviour is untouched by this release |

The v1.7.1 engine, pipeline, session, import, exporter, LLM-harness, parakeet and MCP suites remain
the regression baseline; this release changed the renderer, the window chrome, the icon and the smoke
harness only.

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
├─ assets/            icon (multi-size .ico), brand
├─ scripts/           build / fetch / verify helper scripts
├─ tests/             unit tests + fixtures
└─ tools/             test harnesses + dev utilities (engine, pipeline, smoke, skins, icon, inspectors)
```

## Quick start (from source)

Requires **Node.js 20+** and PowerShell (the native setup scripts are PowerShell).

```bash
npm install
npm run native:whisper   # fetch/build whisper.cpp + CUDA (see docs/DEV.md for the toolkit pin)
npm run native:models    # download the default ggml model
npm run native:diarizer  # build NeMo-Speech.cpp (speaker diarization) + fetch its model
npm run dev              # launch the app
npm run smoke            # headless boot + screenshot + diagnostics (add -- --smoke-show for visible artifacts)
npm run gen:skins        # regenerate theme/skins.css + skins.json from skins.js
npm run check:skins      # contrast gate for every skin in both modes
npm run icon             # rebuild assets/icon.ico from the raw artwork
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
- [`docs/v1.8.0-tech-moca-redesign.md`](docs/v1.8.0-tech-moca-redesign.md) — Phase I redesign and Phase II skins (shipped in v1.9.0)
- [`docs/warm-ink-tokens.md`](docs/warm-ink-tokens.md) — archived Warm Ink palette (skin colour source)
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
