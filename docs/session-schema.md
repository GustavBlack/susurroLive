# Session Schema (`session.json`)

The session file is the **single source of truth** for a recording. Everything the UI shows on
reopen is derived from it.

## Folder layout

A session is a folder. The user chooses the *parent* folder before recording; the app creates a
timestamped session folder inside it.

```
<userChosenFolder>/
└─ 2026-09-12_143022_Weekly-Sync/        # one session
   ├─ AGENTS.md                           # self-describing contract (see below)
   ├─ session.json                        # the contract below
   ├─ audio/
   │  ├─ chunk_0000.wav
   │  ├─ chunk_0001.wav
   │  └─ ...
   ├─ transcripts/
   │  ├─ chunk_0000.json                  # raw whisper.cpp output for the chunk
   │  ├─ chunk_0001.json
   │  └─ ...
   ├─ exports/                            # created on demand
   │  ├─ full.txt
   │  ├─ full.srt
   │  └─ full.json
   └─ temp/                               # scratch; safe to delete
```

Rationale: audio, transcripts and temp are separated so a user can grab just the audio, just the
text, or ship the whole folder. `temp/` is disposable.

---

## The contract

```jsonc
{
  "version": 1,                           // schema version; gates migrations
  "id": "0f2b1c9a-...",                   // uuid v4
  "name": "Weekly Sync",
  "createdAt": "2026-09-12T14:30:22-07:00",
  "updatedAt": "2026-09-12T15:12:04-07:00",

  "environment": {                        // stamped at record time (reproducibility)
    "gpu":  { "vendor": "NVIDIA", "model": "RTX 5090", "cuda": true, "compute": "12.0" },
    "cpu":  { "model": "AMD Ryzen ...", "cores": 16 },
    "os":   "Windows 11 26100",
    "app":  "0.0.0"
  },

  "recording": {
    "startedAt": "2026-09-12T14:30:22-07:00",
    "stoppedAt": "2026-09-12T15:10:00-07:00",
    "durationSec": 2378.4,
    "sampleRate": 48000,
    "channels": 2,
    "chunkSec": 30,
    "sources": [
      { "id": "src_mic",  "kind": "mic",      "deviceId": "...", "label": "Shure MV7",     "gain": 1.0, "muted": false },
      { "id": "src_sys",  "kind": "loopback", "deviceId": "default", "label": "System Audio", "gain": 1.0, "muted": false }
    ]
  },

  "import": {                             // PRESENT ONLY on imported sessions
    "sourceFile": "D:/recordings/meeting.mp4",
    "sourceName": "meeting.mp4",
    "format": { ... },                    // ffprobe format block (container, duration, bitrate, …)
    "sourceDurationSec": 2378.4,
    "importedAt": "2026-09-20T10:00:00-07:00"
  },

  "model": {
    "name": "small.en",                   // ggml model id
    "language": "en",                     // or "auto"
    "device": "cuda",                     // "cuda" | "cpu"
    "vad": true
  },

  "chunks": [
    {
      "index": 0,
      "offsetSec": 0,                      // cumulative captured samples / sampleRate
      "durationSec": 30.0,
      "audioFile": "audio/chunk_0000.wav",
      "transcriptFile": "transcripts/chunk_0000.json",
      "status": "done",                    // pending|queued|running|done|error
      "error": null,
      "attempts": 1,
      "spokenSec": 27.4,                   // non-silence duration (post-VAD)
      "words": [
        { "t": 0.42, "d": 0.28, "w": "Okay" },
        { "t": 0.70, "d": 0.15, "w": "so" }
      ],
      "text": "Okay so let's start with the numbers."
    }
    // ...
  ],

  "transcript": {
    "language": "en",
    "fullText": "Okay so let's start with the numbers. ...",   // concatenated, seam-normalized
    "words": [                                                  // GLOBAL timeline (offset-applied)
      { "t": 0.42, "d": 0.28, "w": "Okay", "chunk": 0 },
      { "t": 0.70, "d": 0.15, "w": "so",   "chunk": 0 }
      // t here is absolute session time
    ],
    "segments": [                                               // sentence-level view for reading/export
      { "start": 0.42, "end": 3.11, "text": "Okay so let's start with the numbers." }
    ]
  },

  "exports": [                                                  // written export artifacts
    { "kind": "txt",  "path": "exports/full.txt",  "at": "..." },
    { "kind": "json", "path": "exports/full.json", "at": "..." }
  ],

  "diarization": {                        // OPTIONAL — present only after speaker diarization
    "version": 1,                          // shape of this block
    "engine": "nemo-speech 0.1.0+97a15af",
    "model": "Nemotron-3-Diarization.q8_0",
    "createdAt": "2026-09-24T18:00:00.000Z",
    "audioSec": 2378.4,                    // length of the audio that was diarized
    "speakers": 3,
    "turns": [                             // who spoke when, GLOBAL seconds, sorted by start
      { "start": 0.40, "end": 4.21, "speaker": "spk0" },
      { "start": 4.60, "end": 9.02, "speaker": "spk1" }
    ]
  }
}
```

### Field notes

- **`chunks[].offsetSec`** is the *only* thing that makes chunked transcription sync with a single
  audio timeline. It comes from cumulative captured sample counts, not the chunk index or wall
  clock. Pausing closes a partial chunk; resuming starts the next chunk at the end of the actual
  recorded audio. Paused time adds neither silence nor gaps to playback or transcript timestamps.
- **`recording.durationSec`** measures captured audio and excludes paused time. Chunk durations
  retain sample precision, including short chunks closed by pause or stop; `chunkSec` is the
  maximum target chunk duration rather than a promise that every chunk has that duration.
- **`chunks[].words[].t`** is **chunk-local**. **`transcript.words[].t`** is **global**. The
  assembly step (`src/main/assemble.js`) is the translation boundary.
- **`import`** exists only on sessions created by media import (`src/main/importer.js`): any
  audio/video file is probed with ffprobe, transcoded with the bundled ffmpeg into the normal
  48 kHz WAV chunk flow, and re-derived so chunk offsets match the source timeline. Imported
  sessions are ordinary sessions afterwards — playback, transcript, and export all work the same.
- **`status`** makes the pipeline crash-safe: on reopen, any chunk in `queued`/`running` is reset
  to `pending` and re-offered to the queue.
- **`diarization`** (optional, `src/main/diarize-join.js`) stores **turns only** — spans of the
  audio on the global timeline (`full.wav` is the chunks concatenated in index order, so turn
  time == `transcript.words[].t`). A word's speaker is **never stored**: `transcript.words` is
  rebuilt on every open and every `chunkDone`, and seam de-dup can re-index it, so the speaker
  is derived at send/export time with `assignSpeakers()`. A word belongs to whoever is talking
  when it **starts**; its duration is ignored, because whisper stretches the last word before a
  pause across the silence (measured on a 3-voice fixture: start point 97.6% correct, largest
  overlap 92.9%, midpoint 92.3%):
  1. the turn containing `t` (crosstalk → the earlier-starting turn);
  2. else the nearest turn edge within 1.0 s (tie → the preceding turn);
  3. else `null`.
  Speaker ids are `spk0..spkN` in order of first appearance (arrival order, not identity).
  The audio never changes after stop/import, so turns never go stale; a malformed block is
  dropped on load instead of refusing the session.
- **`version`** gates migrations. Bump + add a `migrate_vN_to_vN1` only for **breaking** shape
  changes — a bump makes every older build refuse the file. Optional additive blocks (like
  `diarization`) keep the version: older builds preserve unknown keys when they re-save, and
  `AGENTS.md`'s `MANIFEST_VERSION` bumps instead.

### Word object

```ts
type Word = {
  t: number;   // start, seconds
  d: number;   // duration, seconds
  w: string;   // the token/word text
  chunk?: number; // present only on the global timeline
};
```

### Validation

Validated on load by a hand-rolled validator in `src/main/session.js` (zero runtime dependencies
outside Electron — deviation from the original zod plan, recorded in `DEV.md § Deviations`).
On unknown `version`, refuse to open with a clear message rather than silently corrupting.
On valid, hydrate the UI model.

---

## Human-readable sidecars

`session.json` is the machine contract; the `exports/` folder holds human deliverables:

- `full.txt` — clean prose, no timecodes, seam-normalized.
- `full.json` — the `transcript` block verbatim (portable, timecoded).
- `full.srt` / `full.vtt` — subtitle formats derived from `transcript.segments` (**deferred to v2**).
- audio export — re-muxed from `audio/chunk_*.wav` into a single file (ffmpeg).

---

## `AGENTS.md` — the folder's self-description

Every session folder is born with `AGENTS.md` next to `session.json`, rendered by
`src/main/agent-manifest.js`. Rationale: the user accumulates **many** session folders and wants
to point any agent (Hermes, Claude Code, a bare script) at one — or at the parent of all of them —
and have it know how to read the data without any other context.

It carries four things:

1. **The naming convention** — `YYYY-MM-DD_HHMMSS_<Slug>`, local wall clock, zero-padded, so
   sorting folder names *is* sorting sessions chronologically.
2. **The folder map** — `audio/`, `transcripts/`, `exports/`, `temp/`, and which are authoritative.
3. **The JSON Schema** (draft 2020-12) for `session.json`, embedded as a fenced ```json block so a
   reader can extract and validate against it directly.
4. **The traps** — the two timelines (`chunks[].words[].t` chunk-local vs `transcript.words[].t`
   global), `status != "done"` meaning *missing speech* rather than silence, `engine: "demo"`
   never being real transcription, `exports[]` being stale snapshots, `session.folder` going stale
   if the folder moves, and `temp/` being disposable.

**When it is written.** At `createSession()`, and refreshed by `ensureManifest()` on
`session:open` so folders created before the manifest existed pick one up. Rendering is
deterministic (versions, no timestamps) and a byte-identical file is left alone, so the mtime stays
honest and re-opening a session never churns the folder.

**Failure is non-fatal.** `write()` returns `{ok:false,error}` instead of throwing; a read-only or
locked folder must never block a recording. `MANIFEST_VERSION` bumps when the manifest text gains a
rule or an optional block; `SCHEMA_VERSION` bumps only on breaking JSON shape changes — keep the
embedded schema's `version.const` in step with the latter. Recipe §4.6 in the manifest carries
the speaker join rule in Python; it is cross-checked against `assignSpeakers()`.

Regression test:

```bash
node tools/test-session-manifest.js
```

It asserts the file lands in the folder, that the embedded schema parses and agrees with
`SCHEMA_VERSION` and the pipeline's real status literals, that refresh is idempotent, and that an
impossible write path returns an error rather than throwing into `createSession`.
