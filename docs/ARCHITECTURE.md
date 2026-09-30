# Architecture

Three processes, one contract.

```
┌─────────────────────────────────────────────────────────────────────┐
│  RENDERER  (Chromium)                                                │
│  warm-ink UI · transcript view · equalizer · transport · settings    │
│  No Node. Talks only through the preload bridge.                     │
└───────────────▲──────────────────────────────────────────┬──────────┘
                │ IPC (invoke/on)                          │
                │                                          │
┌───────────────┴──────────────────────────────────────────▼──────────┐
│  MAIN  (Node)  — the orchestrator, owns all state                    │
│                                                                      │
│  ┌────────────┐  ▸ CaptureManager   device enum, per-source streams  │
│  │  CAPTURE   │  ▸ MixBus           summed PCM ring @48k, gain/mute  │
│  │            │  ▸ LevelMeter       per-source RMS/peak @30Hz        │
│  │            │  ▸ Chunker          roll mix → audio/chunk_NNNN.wav  │
│  └─────┬──────┘           │ emits "chunk:closed"                     │
│        │                  ▼                                          │
│  ┌─────▼──────────────────────────────────────────┐                 │
│  │  PIPELINE  Queue → WorkerPool → whisper.cpp    │                 │
│  │  assemble.ts merges chunk-local → global time  │                 │
│  └─────┬──────────────────────────────────────────┘                 │
│        │                                                             │
│  ┌─────▼──────┐  ┌───────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  SESSION   │  │   GPU     │  │   MODELS     │  │   EXPORT     │  │
│  │  json I/O  │  │  detect   │  │ download/    │  │ txt/json     │  │
│  │ AGENTS.md  │  │  warn     │  │ cache        │  │ audio        │  │
│  └────────────┘  └───────────┘  └──────────────┘  └──────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  DIARIZE (post-hoc)  full.wav → turns → session.diarization  │   │
│  │  diarize-join: word speaker derived from turns at send time  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────┬────────────────────────────────────┬──────────────────┘
               │ child_process.spawn                │ spawn (once per run)
               ▼                                    ▼
  whisper-cli.exe (per chunk,          bin/diarizer/nemo-speech.exe diarize
  CUDA or CPU)                          (own folder: own ggml DLLs)
```

## Processes & why

| Process | Runs | Responsibility |
| --- | --- | --- |
| **Renderer** | Chromium | Presentation only. No file system, no native modules. |
| **Main** | Node | Everything stateful: capture, mixing, chunking, queueing, sessions, GPU probing, exports. |
| **whisper sidecar** | Native | Transcribe one audio file → timecoded JSON. Stateless per invocation. |
| **diarizer sidecar** | Native | Once per session, after transcription: `full.wav` → speaker turns (JSON). Stateless. |

### Speaker diarization (post-hoc)

`diarize:run` (or auto-run when the pipeline goes idle after Stop/Import) spawns
`nemo-speech diarize` over `audio/full.wav` — the chunks concatenated in index order, i.e. the
global timeline — and stores only the **turns** in `session.json → diarization`. A word's speaker
is never stored: `transcript.words` is rebuilt on every open/chunk and can re-index, so
`diarize-join.assignSpeakers()` derives it (word **start** inside a turn, else nearest turn within
1 s) whenever the transcript is sent to the renderer or exported. Results are written to the
session the run started for, even if the user switched sessions meanwhile. Rationale and
measurements: [`adr/0005-diarization-sidecar.md`](adr/0005-diarization-sidecar.md).

Keeping transcription in a **sidecar process** (rather than a Node addon) buys three things:
1. A CUDA crash can't take down the UI.
2. Concurrency is just "spawn N processes."
3. The engine is swappable — whisper.cpp today, something else tomorrow, same contract.

## The IPC contract (preload bridge)

The renderer never sees Node. Preload exposes a narrow, typed surface:

```ts
// invoke (renderer → main, returns a promise)
devices.list()            : Promise<Device[]>
session.create(parentDir, name) : Promise<SessionMeta>
session.open(path)        : Promise<Session>
session.save(patch)       : Promise<void>
capture.start(sourceIds)  : Promise<void>
capture.stop()            : Promise<void>
capture.setMute(id, bool) : Promise<void>
capture.setGain(id, n)    : Promise<void>
transcribe.retry(chunkIdx): Promise<void>
export.run(kind, opts)    : Promise<string>   // returns output path
gpu.probe()               : Promise<GpuInfo>
models.list()/models.download(id) : Promise<...>
settings.get()/settings.set(patch) : Promise<Settings>

// events (main → renderer)
on('levels',      (perSource: Record<string,number>) => …)   // ~30 Hz
on('chunk',       (c: ChunkStatus) => …)                     // state transitions
on('transcript',  (w: Word[]) => …)                          // appended words
on('status',      (s: AppStatus) => …)                       // idle/recording/processing
on('progress',    (p: Progress) => …)                        // model dl, export, catch-up
```

Design rule: **main owns truth; renderer holds a projection.** The renderer can be reloaded at any
time and re-hydrates from `session.json` + a state snapshot requested over IPC.

## Capture layer

- **Devices** — enumerated once at demand (`devices.list()`), labeled by kind (mic / loopback / app).
- **Streams** — each source opens independently and pushes PCM into the mixer.
- **MixBus** — sums *unmuted* sources, per-source `gain`, into one ring buffer at 48 kHz.
  Muting a source removes it from the sum but keeps its own level meter live (so the user can still
  "test the feed" of a muted track).
- **LevelMeter** — per-source RMS + peak, computed on the raw (pre-mute) stream, throttled to 30 Hz.
- **Chunker** — driven by a **wall-clock timer**, not by data arrival (loopback is silent when the
  system is silent). On each boundary it closes the current WAV and emits `chunk:closed`.

Details: [`audio-capture.md`](audio-capture.md).

## Transcription pipeline

```
chunk:closed ─► Queue.enqueue(chunk)
                   │
        WorkerPool ─┴─► (idle worker) ─► spawn whisper-cli -m model -f chunk.wav --json
                   │                         │
                   │◄── stdout JSON ─────────┘
                   ▼
        assemble.ts  (shift words by offsetSec, seam-normalize, append to global timeline)
                   │
                   ▼
        session.save()  +  emit 'transcript'  +  emit 'chunk'
```

- **States:** `pending → queued → running → done | error`. Persisted per chunk (crash-safe).
- **Concurrency:** GPU → 1 worker (VRAM), CPU → `min(4, cores/2)`.
- **Catch-up:** on Stop, the queue drains; the pipeline strip + ETA show the tail finishing.
- **Retry:** a chunk in `error` can be re-queued from the UI.

Details: [`transcription-pipeline.md`](transcription-pipeline.md).

## Data flow on reopen

```
open session folder
   └─ read session.json ─► zod validate ─► migrate if needed
        ├─ hydrate source array + settings
        ├─ hydrate chunks + statuses (re-queue anything stuck in running/queued)
        ├─ hydrate transcript timeline
        ├─ refresh AGENTS.md (the folder's self-describing contract; see session-schema.md)
        └─ renderer renders; audio served from audio/ over a local file protocol
```

## Failure isolation

| Failure | Blast radius | Recovery |
| --- | --- | --- |
| whisper-cli crash | one chunk | mark `error`, offer retry |
| diarizer crash / timeout | that run | toast + `diarizeError`; previous speakers (if any) kept |
| GPU OOM | one chunk | retry on CPU for that chunk |
| capture device unplugged | that source | drop source, keep recording others, warn |
| renderer reload | UI only | re-hydrate from main's snapshot |
| app crash mid-record | session | on reopen, stuck chunks reset to `pending` |
