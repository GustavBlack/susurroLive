# susurroLive — Development Notes

## Run it

Double-click **`run-susurroLive.bat`** in the project root. It checks Node, reports
whisper/GPU status, installs dependencies on first run, then launches the app.

Or from a terminal:

```bash
npm run dev      # electron .
npm run smoke    # headless boot + screenshot + diagnostics, then exits
```

## What's wired (phases 0–7)

| Phase | Status | Notes |
| --- | --- | --- |
| 0 — scaffolding | ✅ | repo, docs, ADRs, schema, Warm Ink tokens |
| 1 — native engine | ✅ | whisper.cpp built CUDA sm_120 → `native/bin`; `small.en` in `native/models` |
| 2 — capture layer | ✅ | mic + system loopback → gain → analyser → mix → PCM16 → main |
| 3 — streaming pipeline | ✅ | chunk closes → queued → whisper → timecoded merge, during recording |
| 4 — session system | ✅ | folder + `session.json` + `AGENTS.md` (per-folder agent contract), create/open/list/rename, crash-recovery statuses |
| 5 — UI (warm ink) | ✅ | source array, transport, transcript, squares visualizer, pipeline strip, settings |
| 6 — playback & export | ✅ | full.wav concat, karaoke follow, `.txt` / `.json` / audio |
| 7 — package | ✅ | electron-builder portable → `build/susurroLive-1.1.0-portable.exe`; only `small.en` bundled (NSIS ~2 GB payload ceiling) |

Also shipped beyond the plan: **pause/resume** (chunk-exact; paused time excluded from timer and
WAV) and **import** (any audio/video file → a regular session via bundled ffmpeg —
`src/main/importer.js` re-derives chunk offsets and writes `session.import`).

## Manual test checklist

1. **Boot** — window opens at 820×1040, Warm Ink palette, banner tells you LIVE vs DEMO.
2. **Folder** — click *Session folder…* → pick a parent dir. Then *Sessions ▤ → New session…*.
3. **Sources** — *＋ Microphone* adds a row with a device dropdown + live meter.
   *＋ System Audio* adds the WASAPI loopback row. Play music → its meter should move.
4. **Mute** — hit *mute* on a row: it leaves the mix but **its meter keeps moving** (by design).
5. **Record** — press the record button. Timer runs; the right rail animates.
6. **Chunking** — every `chunk` seconds a chip appears in the CHUNKS strip and flips
   `pending → queued → running → done` (green). Transcript text appears *while recording*.
7. **Stop** — the tail catches up; status returns to Ready; Play enables.
8. **Playback** — press ▶. The transcript highlights word-by-word and auto-scrolls; the rail
   switches to a spectrum. Click any word to seek there.
9. **Reopen** — *Sessions ▤* → click the session. Transcript + audio reload.
10. **Export** — `.txt`, `.json`, audio. Files land in `<session>/exports/`.
11. **Pause / Resume** — pause mid-recording: the current chunk closes; resume continues the same
    audio timeline (no silence gap for the paused interval, timer excludes it).
12. **Import** — import an audio or video file: ffmpeg transcodes it into a regular session
    (chunks + transcript), and the transcript plays back against the imported audio.
13. **Speakers** — on a finished two-voice session, *◐ Identify speakers* (disabled while chunks
    are still transcribing) shows a spinner, then S1/S2 chips at each turn, tinted underlines and
    a legend. Reopen the session: labels persist. Export `.txt`: one paragraph per speaker.
    Settings → *Identify speakers automatically* runs it once transcription goes idle.

## Models

The full catalogue lives in `src/main/models.js` (`CATALOG`, six models):

| Model | Size | Lang | Notes |
| --- | --- | --- | --- |
| `tiny.en` | 75 MB | en | fastest, lowest quality |
| `base.en` | 142 MB | en | |
| `small.en` | 466 MB | en | **default** English; the quality/speed knee |
| `medium.en` | 1.5 GB | en | |
| `large-v3-turbo` | 1.5 GB | multi | near-large quality, roughly 2x faster |
| `large-v3` | 2.9 GB | multi | best quality available; slowest |

**Packaged EXE bundles only `small.en`** (the portable target's NSIS payload has a hard ~2 GB
ceiling). On a dev machine all six may sit in `native/models/`; anything missing can be pulled
at runtime from **Settings → Model → download**. Downloads stream into `native/models` with a
live progress bar and byte counter, and can be cancelled mid-flight. Any installed model can be
deleted from the same list — the currently-active model is protected from deletion.

**Changing the model applies to the session in flight** — the next chunk picks it up, no
restart and no new session needed.

Approximate VRAM while transcribing (one whisper process at a time on GPU, so these are peak):

| Model | VRAM |
| --- | --- |
| `small.en` | ~0.5 GB |
| `large-v3-turbo` | ~1.6 GB |
| `large-v3` | ~3.5 GB |

With 32 GB on the 5090 there's ample headroom even at `large-v3`.

Model files are standard ggml; `od -N 4 -t x1` should show magic `6c 6d 67 67` ("ggml").
The catalog lives in `src/main/models.js` (`CATALOG`), with downloads streamed from
HuggingFace by `ModelManager`.

## Transcript display

The transcript is **continuous prose**, not one line per timestamp:

- Words flow as a single wrapping block, so phrases and sentences are never cut apart.
- Timecodes sit in the **left margin** (every 15 s), right-aligned to the line they belong to,
  and never break the text flow.
- Rendering is **incremental** — each new chunk appends words instead of rebuilding the DOM, so
  scroll position and the active-word highlight survive every update.
- **⤓ follow** appears when you scroll away. Re-engaging it turns on teleprompter mode: the spoken
  word is held ~38% down the panel and the view only moves when it leaves that band. Implausibly
  large jumps (from a bad chunk) **snap** instead of animating, so the view can't be flung.
- **Scrollbars are themed** (dark track, slim rounded thumb, no arrow buttons) via
  `::-webkit-scrollbar` at the bottom of `style.css`. ⚠️ Never set `scrollbar-width` anywhere in
  the CSS: when it is present Chromium switches to the standard scrollbar and **silently ignores
  every `::-webkit-scrollbar` rule**, which is exactly how the light-grey default reappears.
- **The teleprompt tail is a `::after` pseudo-element, NOT `padding-bottom`.** With
  `box-sizing: border-box` an element can never be shorter than its own vertical padding, so
  `padding-bottom: 55vh` silently became a **572px minimum height** the flex box could not shrink
  below. The transcript then overhung its panel by ~38px and its scrollbar painted outside the
  rounded frame. `min-height: 0` does **not** fix this — padding always wins over it. Keeping the
  tail on `.tx-inner::after` removes the floor. `npm run smoke` now asserts
  `transcript.overhangPx <= 0` so this can't regress silently.

### Whisper quirks we scrub

Two model failure modes are cleaned in `src/main/whisper.js` before anything downstream sees them:

1. **Degenerate tokens** — a repetition loop ends by stacking dozens of tokens on one timestamp
   with zero duration (observed: 62 words at `t=14.400`, `d=0`).
2. **Repetition loops** — a 4+ word phrase emitted many times consecutively (observed:
   `"ask not what your country can do for you"` ×9 inside a single 15 s chunk).

The guard is deliberately conservative — it only fires on a 4+ word phrase repeated **more than
4 times**, so genuine repetition in real speech survives. Note: **`-mc 0` does not prevent these
loops** (verified — byte-identical output), so a post-processing guard is required.

### Seam de-duplication

`assemble.js` drops a word whisper emits twice across a chunk seam (the same word closing chunk N
and opening chunk N+1, within 0.9 s). Segments now use **index ranges** instead of timestamp
matching — the previous approach duplicated words whenever ranges overlapped, which is what made
the highlight flicker between two copies of the same word. The timeline is also forced
non-decreasing, since an out-of-order timestamp makes the highlight jump backwards.

### Tests

```bash
node tools/test-assemble.js                      # seams, monotonic, index ranges
node tools/test-session-manifest.js              # AGENTS.md written, schema valid, refresh idempotent
node tools/test-loopguard.js <whisper.json>      # repetition-loop guard vs real output
node tools/test-pipeline.js                      # chunker -> pipeline -> timeline
node tools/test-engine.js                        # single-file transcription
node tools/make-demo-session.js <dir> 3 15       # build a multi-chunk session to inspect
node tools/inspect-session.js <session-folder>   # dump a session's chunks + timeline

# speaker diarization
node tools/test-diarize-join.js                  # join rules, scale, python recipe == JS
node tools/test-diarizer.js                      # sidecar module vs tools/fake-diarizer.js
node tools/test-diarize-ipc.js                   # real main + preload, stubbed sidecar
node tools/test-exporters.js                     # speaker paragraphs; undiarized byte-identical
node tools/make-demo-session.js <dir> 1 30 small.en --audio=<wav> --diarized
```

The app can also boot straight into an existing session for inspection:

```bash
npx electron . --smoke --smoke-session="<session folder>"
```

## Known limitations (v1 / dev build)

- **Short-chunk floor (1.0 s).** Chunks under a second are near-silence and whisper hallucinates
  on them — observed producing 7 words at `t ≤ 10 s` inside a **0.76 s** clip, which corrupted the
  global timeline to a 20 s end-position on an 11 s recording. Those chunks are now marked
  `engine: "skipped"` and contribute no words. Words whose local time exceeds the chunk duration
  (+0.5 s tolerance) are also dropped.
- **Model reload per chunk.** whisper-cli is invoked per chunk, so the model loads each time
  (~0.5 s). Fine at a 60 s window; v2 replaces it with a resident model.
- **Chunk seams.** A word split across a chunk boundary can be mangled. v2 = overlap windows.
- **`.srt`/`.vtt`, per-app capture** are deferred to v2 (see `PLAN.md §3`).
- **Speaker diarization is post-hoc.** It runs after transcription over `full.wav`; live speaker
  colours while recording are not implemented. Labels are arrival order (Speaker 1 spoke first),
  never identities. Mic + system audio are one mono mix, so a remote group on loopback can read
  as fewer voices. Whisper sometimes places a sentence's last word late, so an occasional
  boundary word lands on the next speaker (~2% of words on the test fixture).
- **VC++ runtime.** `whisper-cli.exe` and its `ggml*.dll` import `msvcp140`, `vcruntime140(_1)`
  and `vcomp140`, which `native/bin` does not ship — the portable exe relies on the VC++
  2015-2022 redistributable being installed on the target PC. The diarizer carries its own copy
  in `bin/diarizer/`.
- **DEMO mode.** If `native/bin/whisper-cli.exe` or a model is missing, the pipeline fabricates
  placeholder words (tagged `engine: "demo"`) so the full UX is still testable. Never mistake
  demo output for real transcription — the banner and the settings diagnostics both say so.
- **Mic permission.** Windows may prompt on first mic capture.

## Deviations from the original plan (and why)

| Planned | Shipped | Why |
| --- | --- | --- |
| TypeScript + electron-vite | **plain JS, no bundler** | zero build step → a dev app that always starts; TS can be layered on later |
| `native-audio-node` for capture | **Electron `getUserMedia` + desktopCapturer loopback** | no native module to build/keep in sync; loopback is a documented Electron path on Windows |
| `zod` validation | **hand-rolled validator** in `session.js` | zero runtime dependencies outside Electron |
| `src/main/ipc.js` | **folded into `index.js`** | composition root stays in one readable file |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Banner says DEMO MODE | run `scripts/_build-whisper-cuda.bat`, copy artifacts per below |
| Banner says CPU transcription | GPU present but binary not CUDA, or `device` set to `cpu` in Settings |
| CUDA build fails `C4002 ... __cudaLaunch` | CMake grabbed CUDA **13.0**; the script must pin `CUDAToolkit_ROOT` to **v12.9** |
| System audio meter dead | Windows 10 2004+ required; check the output device is playing |
| No mic listed | Windows Settings → Privacy → Microphone → allow desktop apps |
| `whisper-cli.exe not found` | `native/bin/` must contain the exe **and** its `ggml*.dll` + CUDA runtime DLLs |
| No "Identify speakers" button | Settings diagnostics: `diarizer` / `diar model` lines. Run `npm run native:diarizer` |
| Diarizer: `pre_ln transformer variant is not supported` | the v0.1.0 NeMo-Speech.cpp release is too old for Nemotron-3; use `scripts/build-diarizer.ps1` (pinned main) |
| Diarizer build: `git not on PATH after env setup` | `cmd.exe` truncated a >8191-char PATH inside `vcvars64.bat`; `build-diarizer.ps1` starts the build with a minimal PATH |
| Diarizer build: `Filename too long` in llama.cpp | the source tree must be on a short path (default `%TEMP%\ns`) |

## Native artifacts layout

```
native/
├─ bin/          whisper-cli.exe, whisper.dll, ggml*.dll, cudart64_*.dll, cublas64_*.dll, cudnn64_9.dll,
│  │             ffmpeg.exe + ffprobe.exe (used by the importer; avcodec/avformat/swresample DLLs)
│  └─ diarizer/  nemo-speech.exe + nemo_speech_asr*.dll + ITS OWN ggml*.dll + VC++ runtime
│                (own folder: same DLL names as whisper's, different ggml revision)
├─ models/       ggml-*.bin (all six on dev machines; only small.en ships in the package)
│                Nemotron-3-Diarization.q8_0.gguf (speaker diarization; ships in the package)
└─ src/          whisper.cpp checkout + build-cuda/ (gitignored)
```

`Engine` looks for `whisper-cli.exe` first, then `main.exe`. `binaryCuda` is inferred from
CUDA runtime DLLs sitting next to the exe.

## Build the whisper sidecar

```bash
cmd.exe /c "scripts\_build-whisper-cuda.bat"
```

> **Use the Ninja script for CUDA:** `scripts/_build-whisper-cuda-ninja.bat`.
>
> Three CUDA toolkits are installed (12.8 / 12.9 / 13.0). Two separate traps, both now handled:
> 1. **CUDA 13.0 cannot build this tree.** CMake's VS generator routes CUDA through MSBuild's
>    `CUDA 13.0.targets` and emits a split-brain include list (12.9 headers + 13.0 nvcc), which
>    dies with `error C4002: too many arguments for function-like macro invocation '__cudaLaunch'`
>    in ggml-cuda's generated `*.cudafe1.stub.c` files.
> 2. **`-DCMAKE_CUDA_COMPILER` is ignored under the VS generator.** CMake re-derives the newest
>    toolkit from the registry and the `CUDA_PATH_V13_0` env var. Clearing those vars doesn't help
>    either — it breaks the MSBuild CUDA build-customization instead
>    (`The CUDA Toolkit directory '' does not exist`).
>
> **Ninja sidesteps both**: it invokes nvcc directly rather than through MSBuild targets, so
> `CUDACXX` + `CMAKE_CUDA_COMPILER` actually stick. Verified: CMake then reports
> `CUDA compiler identification is NVIDIA 12.9.86` (it reports `13.0.48` under the VS generator).
> CUDA 12.8+ is required for Blackwell `sm_120`; the arch flag is `-DCMAKE_CUDA_ARCHITECTURES=120`.
>
> `scripts/_build-whisper-cuda.bat` (VS generator) is kept for reference but is **known broken**
> on this machine. `scripts/_build-whisper-cpu.bat` is the guaranteed baseline.

then copy from `native/src/whisper.cpp/build-cuda/bin/Release/` into `native/bin/`:
`main.exe → whisper-cli.exe`, `ggml*.dll`, plus `cudart64_*.dll` / `cublas64_*.dll` /
`cublasLt64_*.dll` from `CUDA/v12.9/bin` and `cudnn64_9.dll` from the cuDNN install.

Verify with:

```bash
node tools/test-engine.js
```

It transcribes `samples/jfk.wav`, asserts real (non-demo) output, and checks that the
`offsetSec` shift is applied correctly during assembly.

## Build the diarizer sidecar

```bash
npm run native:diarizer
```

`scripts/build-diarizer.ps1` clones NVIDIA NeMo-Speech.cpp at a pinned commit into a short path
(`%TEMP%\ns`), applies `scripts/patches/nemo-speech-cpu-threads.patch`, runs the upstream
`scripts/windows/build.ps1 -Backend cpu -Profile asr`, then installs into `native/bin/diarizer/`:
`nemo-speech.exe`, `nemo_speech_asr*.dll`, its own `ggml*.dll`, and the VC++ runtime
(`msvcp140`, `vcruntime140(_1)`, `vcomp140`) from the Visual Studio redist folder. The model
`Nemotron-3-Diarization.q8_0.gguf` (102 MiB, `huggingface.co/nvidia/Nemotron-3-Diarization`) is
downloaded into `native/models/` and SHA-256 checked; the script ends by asking the runtime
whether it accepts the model.

- **Why a source build:** Nemotron-3 support landed on NeMo-Speech.cpp `main` after the v0.1.0
  release; the v0.1.0 prebuilt fails with `sortformer: pre_ln transformer variant is not
  supported`. The `audio-cpp/Nemotron-3-Diarization-GGUF` file targets the audio.cpp fork and is
  rejected by nemo-speech (`architecture not recognized`) — use NVIDIA's own GGUF.
- **Why the patch:** upstream passes a hard-coded 4 to ggml's CPU thread setter. The patch reads
  `NEMO_SPEECH_CPU_THREADS` (default still 4); `diarizer.js` sets half the logical cores, 4..16.
  Output is byte-identical across thread counts.
- **Why its own folder:** the exe ships `ggml.dll`/`ggml-base.dll`/`ggml-cpu.dll` with the same
  names as whisper.cpp's, from a different ggml revision. Windows loads DLLs from the exe's own
  folder first, so `bin/diarizer/` keeps both engines intact.
- `-BuildDir <dir>` reuses an existing build; `-ModelFile <path>` installs a local copy of the model.
