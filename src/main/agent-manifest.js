'use strict';
/**
 * AGENTS.md — the self-describing contract written into every session folder.
 *
 * A session folder is meant to be handed to *any* agent (Hermes, Claude Code, Codex, a plain
 * script) with no other context. This module renders that folder's README-for-machines:
 * the naming convention, the folder layout, the `session.json` JSON Schema, and the rules
 * that keep a reader from mis-reading the two timelines.
 *
 * Contract for callers:
 *   - Writing must NEVER throw into session creation; a failure is returned, not raised.
 *   - Rendering is deterministic (versions only, no timestamps) so re-opening a session
 *     leaves the file byte-identical and an unchanged file is not rewritten.
 *
 * Keep MANIFEST_VERSION in step with the schema: bump it whenever the manifest text gains a
 * rule or an optional block, and bump session.js's SCHEMA_VERSION only for BREAKING JSON shape
 * changes (those need a migration and lock older builds out).
 */
const fs = require('fs');
const path = require('path');

const FILENAME = 'AGENTS.md';
const MANIFEST_VERSION = 4;

const TEMPLATE = `# AGENTS.md — how to read this susurroLive session folder

You are looking at **one recording session** produced by *susurroLive*, a Windows app that
records microphone + system (loopback) audio, cuts it into timed chunks, and transcribes each
chunk with whisper.cpp **while still recording**.

Everything an agent needs is here as plain files. No app, no server, no database, no network.

|  |  |
| --- | --- |
| Written by | susurroLive {{appVersion}} |
| Describes | \`session.json\` schema **v{{schemaVersion}}** |
| Manifest revision | {{manifestVersion}} |
| Refreshed | every time the app opens this folder (idempotent) |

**\`session.json\` is the single source of truth.** Everything else is raw input (\`audio/\`), a
per-chunk sidecar (\`transcripts/\`), a snapshot (\`exports/\`), or scratch (\`temp/\`).

---

## 1 · Naming convention

A session is a folder named \`YYYY-MM-DD_HHMMSS_<Slug>\`:

\`\`\`
2026-09-12_143022_Weekly-Sync
└──┬───┬──┘└─┬──┘ └────┬────┘
   │   │     │         slug of the session name
   │   │     └─ creation time, local wall clock, 24h, zero-padded
   └───┴─ creation date, local wall clock
\`\`\`

- Times are the **studio's local clock**, zero-padded, so **lexicographic sort == chronological
  sort**. Sorting folder names is a valid way to order sessions in time.
- The slug is the session name with each run of non-word characters collapsed to \`-\`, leading
  and trailing dashes stripped, truncated to 48 characters, and defaulting to \`session\`.
- Session folders are siblings under a parent folder the user chose
  (e.g. \`D:\\Sessions\\2026-09-12_143022_Weekly-Sync\`). Never assume a fixed parent.

## 2 · Folder structure

\`\`\`
<this folder>/
├── AGENTS.md                 ← this file (generated; edits are overwritten)
├── session.json              ← the contract — see §3
├── audio/
│   ├── chunk_0000.wav        ← 48 kHz PCM16 mono, 4-digit zero-padded chunk index
│   ├── chunk_0001.wav
│   ├── ...
│   └── full.wav              ← present only after the user runs the audio export
├── transcripts/
│   ├── chunk_0000.json       ← raw whisper.cpp result for that one chunk
│   └── ...
├── exports/                  ← snapshots the user asked for; may be empty or absent
│   ├── full.txt
│   ├── full.json
│   └── full.wav
└── temp/                     ← scratch; safe to delete, never authoritative
\`\`\`

Audio is **split into chunks**: each holds up to \`chunkSec\` seconds. Pause and Stop can
close a shorter chunk. Paused time is omitted from the audio. Use each chunk's explicit
\`offsetSec\` to locate it on the audio timeline; do not calculate it from its index.
\`index\` is the order key — sort by it rather than trusting array position.

\`transcripts/chunk_NNNN.json\` is a sidecar copy of one chunk's raw result:

\`\`\`json
{ \"index\": 0, \"offsetSec\": 0, \"engine\": \"whisper.cpp 1.7.6\", \"language\": \"en\",
  "words": [ { "t": 0.42, "d": 0.28, "w": "Okay" } ], "text": "Okay ..." }
\`\`\`

Its \`words[].t\` are **chunk-local**, exactly like \`session.json → chunks[].words[].t\`.

## 3 · \`session.json\`

### JSON Schema — draft 2020-12

\`\`\`json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "susurroLive session.json",
  "type": "object",
  "required": ["version", "chunks", "transcript"],
  "properties": {
    "version": { "type": "integer", "const": 1, "description": "Schema version; gates migrations." },
    "id": { "type": "string", "description": "UUID v4 for this session." },
    "name": { "type": "string" },
    "folder": { "type": "string", "description": "Absolute path recorded at creation; may be stale if the folder was moved." },
    "createdAt": { "type": "string", "description": "ISO-8601 with UTC offset." },
    "updatedAt": { "type": "string", "description": "ISO-8601; last write to this file." },
    "environment": {
      "type": ["object", "null"],
      "description": "Stamped at record time for reproducibility.",
      "properties": {
        "gpu": {
          "type": ["object", "null"],
          "properties": {
            "vendor": { "type": "string" },
            "model": { "type": "string" },
            "cuda": { "type": "boolean" },
            "compute": { "type": "string" }
          }
        },
        "cpu": { "type": ["object", "null"] },
        "os": { "type": "string" },
        "app": { "type": "string", "description": "susurroLive version that wrote the file." }
      }
    },
    "recording": {
      "type": "object",
      "properties": {
        "startedAt": { "type": ["string", "null"], "description": "null if the session was created but never recorded." },
        "stoppedAt": { "type": ["string", "null"] },
        "durationSec": { "type": "number", "minimum": 0 },
        "sampleRate": { "type": "integer", "description": "Hz. Always 48000." },
        "channels": { "type": "integer", "description": "Always 1: every unmuted source is summed to mono." },
        "chunkSec": { "type": "number", "description": "Target chunk length in seconds." },
        "sources": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": { "type": "string" },
              "kind": { "enum": ["mic", "loopback", "app"] },
              "deviceId": { "type": "string" },
              "label": { "type": "string", "description": "Human device name, e.g. 'Shure MV7'." },
              "gain": { "type": "number" },
              "muted": { "type": "boolean" }
            }
          }
        }
      }
    },
    "model": {
      "type": "object",
      "properties": {
        "name": { "type": "string", "description": "ggml model id, e.g. 'small.en'." },
        "engine": { "enum": ["whisper", "parakeet"], "description": "ASR engine selected for this session (newer sessions; whisper when absent)." },
        "language": { "type": ["string", "null"], "description": "'en', 'auto', or null." },
        "device": { "enum": ["cuda", "cpu", "auto"] },
        "vad": { "type": "boolean" }
      }
    },
    "chunks": {
      "type": "array",
      "description": "One entry per audio chunk. NOT necessarily in index order — sort by index.",
      "items": {
        "type": "object",
        "required": ["index", "offsetSec", "status"],
        "properties": {
          "index": { "type": "integer", "minimum": 0 },
          "offsetSec": { "type": "number", "description": "Cumulative captured audio seconds before this chunk, excluding pauses. The ONLY anchor from a chunk to the global timeline; never infer it from index." },
          "durationSec": { "type": "number" },
          "audioFile": { "type": "string", "description": "Path relative to this folder, e.g. 'audio/chunk_0000.wav'." },
          "transcriptFile": { "type": ["string", "null"] },
          "status": { "enum": ["pending", "queued", "running", "done", "error"] },
          "error": { "type": ["string", "null"] },
          "attempts": { "type": "integer" },
          "engine": { "type": ["string", "null"], "description": "ASR engine that produced the words: whisper.cpp build id, 'parakeet' (sherpa-onnx sidecar), 'skipped' (sub-1s silence chunk) or 'demo' (never real)." },
          "ms": { "type": "number", "description": "Wall-clock transcription time for this chunk." },
          "spokenSec": { "type": "number", "description": "End of the last word, chunk-local." },
          "note": { "type": "string" },
          "text": { "type": "string" },
          "words": { "type": "array", "items": { "$ref": "#/$defs/chunkWord" } }
        }
      }
    },
    "transcript": {
      "type": "object",
      "description": "The whole session, merged across chunks. Rebuilt if any chunk changes.",
      "properties": {
        "language": { "type": ["string", "null"] },
        "fullText": { "type": "string", "description": "All words joined into clean prose, seam duplicates removed." },
        "words": { "type": "array", "items": { "$ref": "#/$defs/globalWord" } },
        "segments": { "type": "array", "items": { "$ref": "#/$defs/segment" } }
      }
    },
    "exports": {
      "type": "array",
      "description": "Snapshots written on demand under exports/. Advisory only — session.json is fresher.",
      "items": {
        "type": "object",
        "properties": {
          "kind": { "enum": ["txt", "json", "audio"] },
          "path": { "type": "string" },
          "at": { "type": "string", "description": "ISO-8601 write time." }
        }
      }
    },
    "import": {
      "type": ["object", "null"],
      "description": "Present only when the session was created by IMPORTING a media file (audio or video). The audio track was decoded with ffmpeg into the same PCM16/48k mono stream live capture produces.",
      "properties": {
        "sourceFile": { "type": "string", "description": "Absolute path of the imported file." },
        "sourceName": { "type": "string", "description": "File name only." },
        "format": { "type": ["string", "null"], "description": "ffprobe format_name list, e.g. 'mov,mp4,m4a,3gp,3g2,mj2'." },
        "sourceDurationSec": { "type": ["number", "null"], "description": "Container duration from ffprobe; lossy containers (aac/mp4) may differ slightly from the decoded length." },
        "importedAt": { "type": "string" }
      }
    },
    "diarization": {
      "type": ["object", "null"],
      "description": "OPTIONAL. Present only after the user ran speaker diarization. Describes the AUDIO (who spoke when), not the words: join turns to transcript.words yourself (see 4.6).",
      "required": ["turns"],
      "properties": {
        "version": { "type": "integer", "description": "Shape version of this block." },
        "engine": { "type": "string", "description": "Diarizer build that produced the turns." },
        "model": { "type": ["string", "null"], "description": "Diarization model id, e.g. 'Nemotron-3-Diarization.q8_0'." },
        "createdAt": { "type": "string", "description": "ISO-8601 time the turns were computed." },
        "audioSec": { "type": ["number", "null"], "description": "Length of the audio that was diarized, seconds." },
        "speakers": { "type": "integer", "minimum": 0, "description": "Distinct speakers found." },
        "turns": { "type": "array", "items": { "$ref": "#/$defs/turn" } }
      }
    }
  },
  "$defs": {
    "chunkWord": {
      "type": "object",
      "required": ["t", "d", "w"],
      "properties": {
        "t": { "type": "number", "description": "Start, seconds — LOCAL to this chunk." },
        "d": { "type": "number", "description": "Duration, seconds." },
        "w": { "type": "string", "description": "The token as whisper emitted it (punctuation attached)." }
      }
    },
    "globalWord": {
      "type": "object",
      "required": ["t", "d", "w"],
      "properties": {
        "t": { "type": "number", "description": "Start, seconds — GLOBAL session time (offset already applied)." },
        "d": { "type": "number" },
        "w": { "type": "string" },
        "chunk": { "type": "integer", "description": "Which chunk produced this word — the authoritative map back to audio." }
      }
    },
    "segment": {
      "type": "object",
      "required": ["start", "end", "text"],
      "properties": {
        "start": { "type": "number", "description": "Global seconds." },
        "end": { "type": "number", "description": "Global seconds." },
        "text": { "type": "string", "description": "Sentence-ish slice, spacing cleaned." },
        "from": { "type": "integer", "description": "Inclusive index into transcript.words." },
        "to": { "type": "integer", "description": "Inclusive index into transcript.words." }
      }
    },
    "turn": {
      "type": "object",
      "required": ["start", "end", "speaker"],
      "properties": {
        "start": { "type": "number", "description": "Global seconds — same clock as transcript.words[].t." },
        "end": { "type": "number", "description": "Global seconds." },
        "speaker": { "type": "string", "pattern": "^spk[0-9]+$", "description": "Arrival-order label: spk0 spoke first. NOT an identity, and not comparable across sessions." }
      }
    }
  }
}
\`\`\`

### Units and conventions

- **All times are seconds** (floats). \`t\` = start, \`d\` = duration, so a word spans
  \`[t, t + d)\`.
- **ISO-8601 strings carry the studio's UTC offset** (e.g. \`2026-09-12T14:30:22-07:00\`), not
  bare \`Z\` — do not silently treat them as UTC unless you parse the offset.
- \`sampleRate\` is 48000 and \`channels\` is 1 for every session: microphones and system audio are
  summed to one mono track, so the **audio has no per-speaker channels**. Who spoke when exists
  only if the optional \`diarization\` block is present (see 4.6); without it, if two people
  talked, their words are interleaved with no speaker attached.
- Audio is 16-bit PCM WAV. \`durationSec\` on a chunk is its real audio length, so the final chunk
  is usually shorter than \`chunkSec\`.
- Keys such as \`auto\` / \`app\` under \`source.kind\` are reserved; v1 records \`mic\` and
  \`loopback\` only.

## 4 · Recipes

Parsing a session needs nothing but \`json\` and file reads. Working examples:

### 4.1 The whole text

\`\`\`python
import json, pathlib
s = json.loads(pathlib.Path("session.json").read_text(encoding="utf-8"))
print(s["transcript"]["fullText"])          # clean prose, no timestamps
\`\`\`

\`\`\`js
const s = JSON.parse(require('fs').readFileSync('session.json', 'utf8'));
console.log(s.transcript.fullText);
\`\`\`

### 4.2 Timecoded quotes

\`\`\`python
for seg in s["transcript"]["segments"]:      # sentence-ish, ~40 words max
    print(f'[{seg["start"]:7.2f} -> {seg["end"]:7.2f}] {seg["text"]}')
\`\`\`

### 4.3 Seek a moment in the audio

The audio is chunked, so a global timestamp maps to one file plus an in-file offset. Both halves
come straight from the data — never re-derive them:

\`\`\`python
def locate(word):
    c = s["chunks"][word["chunk"]]           # word["chunk"] is the authoritative index
    return c["audioFile"], word["t"] - c["offsetSec"]   # apply the offset subtraction ONCE
\`\`\`

### 4.4 Partially transcribed or failed sessions

Only chunks with \`status == "done"\` contribute to \`transcript\`. A session can legitimately be
half-finished — the user may have stopped recording while the tail was still in flight, or a chunk
may have failed:

\`\`\`python
missing = [c["index"] for c in s["chunks"] if c["status"] != "done"]
for c in s["chunks"]:
    if c["status"] == "error":
        print(f'chunk {c["index"]} failed: {c["error"]}')
\`\`\`

When reporting on such a session, **say that coverage is partial and where the gap is** — the
missing window is not silence.

### 4.5 Merging many sessions

Sort sibling session folders by name (that is chronological — see §1), read each
\`transcript.fullText\`, and if you need one continuous timeline, accumulate
\`recording.durationSec\` to offset each session's times.

### 4.6 Who said what (only if \`diarization\` is present)

\`diarization.turns\` are spans of the **audio** on the global timeline — the same clock as
\`transcript.words[].t\`, so no offset is needed. Words carry no speaker; join them. The app uses
exactly this rule (turns are stored sorted by \`start\`). A word belongs to whoever is talking
when it **starts** — ignore \`d\`: whisper stretches the last word before a pause across the
silence, so duration-based matching hands it to the next speaker.

\`\`\`python
def speaker_of(word, turns, max_gap=1.0):
    t = word["t"]
    for tr in turns:                          # 1. turn containing t; crosstalk -> earlier start
        if tr["start"] <= t < tr["end"]:
            return tr["speaker"]
    r = lambda x: round(x, 6)                 # times are millisecond-precise: drop float noise
    gap = lambda tr: r(max(tr["start"] - t, t - tr["end"], 0))
    near = min(turns, key=gap, default=None)  # 2. nearest turn within max_gap seconds
    return near["speaker"] if near and gap(near) <= max_gap else None
\`\`\`

Show \`spk0\` as "Speaker 1", \`spk1\` as "Speaker 2", and so on. \`None\` means no speaker could
be attributed (usually a word in a long silence gap).

## 5 · Rules that break naive readers

1. **There are two timelines, and they are not interchangeable.**
   \`chunks[].words[].t\` is **chunk-local** (starts near 0 in every chunk);
   \`transcript.words[].t\` is **global** session time.
   \`offsetSec\` (cumulative captured audio, excluding pauses) is applied exactly once, when the global timeline is
   built. Adding it yourself to an already-global \`t\` shifts it twice and silently breaks sync.
2. **\`status != "done"\` means that window's speech is missing**, not silent. \`pending\`,
   \`queued\` and \`running\` are states a crash can leave behind; \`error\` means the ASR engine
   (whisper.cpp or parakeet) failed on that chunk and can be retried in the app.
3. **Check \`engine\` before quoting.** \`"demo"\` means the app had no ASR binary/model and
   **fabricated placeholder words** — never present demo text as a real transcript.
   \`"skipped"\` means a chunk under 1.0 s of near-silence was deliberately not transcribed.
4. **\`exports/\` and \`exports[]\` are snapshots, not truth.** Compare their \`at\` against
   \`updatedAt\`; if the session has been appended to since, read \`transcript\` from
   \`session.json\` instead.
5. **\`session.folder\` is a stale absolute path.** It was written when the session was created. If
   the folder was copied or moved, resolve every path against **the folder this file sits in**.
6. **\`temp/\` is disposable** and may hold a half-written file. Never read it; never treat
   \`session.json.tmp\` as a session file.
7. **Join words with a space and then fix the spacing** — whisper attaches punctuation to tokens
   (\`"you" "country," "?"\`), so \`" ".join(words)\` yields \`"country, ?"\`. Collapse the space
   before punctuation: \`.replace(/\\s+([,.;:!?])/g, "$1")\`.
8. **Empty is normal.** A folder can hold no audio, no chunks and an empty \`transcript\` — a
   session created but never recorded has \`recording.startedAt == null\`.
9. **Speaker labels are arrival order, not people.** \`spk0\` is whoever spoke first *in this
   session*; the same person can be \`spk1\` in another session. \`diarization\` may be absent,
   and a word's speaker is never stored — derive it with 4.6.

---

Generated by susurroLive. Deeper reference (schema rationale, pipeline notes) lives in the app
repository under \`docs/session-schema.md\` — that file is **not** part of this folder, so treat
this \`AGENTS.md\` as the contract you have.
`;

/** Render the manifest for a given app/schema version. Deterministic for fixed inputs. */
function render({ appVersion = '0.0.0', schemaVersion = 1, manifestVersion = MANIFEST_VERSION } = {}) {
  return TEMPLATE
    .replace(/\{\{appVersion\}\}/g, String(appVersion))
    .replace(/\{\{schemaVersion\}\}/g, String(schemaVersion))
    .replace(/\{\{manifestVersion\}\}/g, String(manifestVersion));
}

/**
 * Write (or refresh) AGENTS.md into a session folder.
 * Never throws: returns {ok:true, path, changed} or {ok:false, error}.
 * A byte-identical file is left untouched so mtimes stay honest.
 */
function write(root, opts = {}) {
  const file = path.join(root, FILENAME);
  try {
    const text = render(opts);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) {
      return { ok: true, path: file, changed: false };
    }
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    return { ok: true, path: file, changed: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

module.exports = { FILENAME, MANIFEST_VERSION, render, write };
