# susurroLive MCP tools (v1.7)

The live list is always authoritative: run `susurro.ps1 tools -Json` or POST `tools/list`.
This snapshot is for offline reading and prompt context.

Endpoint: `http://127.0.0.1:8790/mcp` (Streamable HTTP, JSON responses, bearer token).
Server name: `susurroLive`. Tools are exposed by Hermes as `mcp_susurro_<tool>` when the
native MCP config is used; the skill helper calls the same tools directly.

## Session + status

| Tool | Input | Returns |
| --- | --- | --- |
| `app_status` | `{}` | appVersion, rendererReady, MCP url/running, GPU/engines, sessionsRoot, settings defaults, current session summary, recording state, pipeline/transcription state |
| `sources_list` | `{}` | microphones `{deviceId,label}`, loopback screens `{id,label}`, current sources, profiles |
| `session_list` | `{parentDir?}` | sessions under parent (default app sessions root), newest first |
| `session_create` | `{parentDir?,name?,chunkSec?,engine?,model?,language?,device?,sources?}` | creates an empty session and makes it active |
| `session_open` | `{folder}` | activates an existing session folder; fails while recording |

## Recording

| Tool | Input | Returns |
| --- | --- | --- |
| `recording_start` | `{profile?,sources?,parentDir?,name?,newSession?,chunkSec?,engine?,model?,language?,device?}` | creates/reuses a session, resolves sources, starts capture; returns folder, sources, sampleRate, chunkSec |
| `recording_pause` | `{}` | pauses capture/recorder; closes the current chunk |
| `recording_resume` | `{}` | resumes the same session/timeline |
| `recording_stop` | `{waitForTranscription?,timeoutMs?}` | closes the final chunk, builds `audio/full.wav`, enqueues the tail; optionally waits |
| `recording_status` | `{}` | recording/paused, elapsed, sources, chunks, pipeline, transcription |
| `transcription_wait` | `{timeoutMs?}` | waits until active chunks are done/error; rejects while recording |
| `transcription_retry` | `{index? , all?}` | requeues one chunk or all outstanding/error chunks |

Profiles:

- `meeting` — default microphone + system loopback
- `voice` — default microphone only
- `system` — system loopback only
- `custom` — exactly the supplied `sources` array

`recording_start` defaults: `profile=meeting`; a new session is created when there is no active
session, the active session already has chunks, or `parentDir`/`name` is supplied. Pass
`newSession:false` to reuse an empty active session; it fails if the session has chunks.

## Transcript + export

| Tool | Input | Returns |
| --- | --- | --- |
| `transcript_get` | `{sessionFolder?,format?,corrected?,includeWords?,offset?,limit?,maxChars?}` | `text` or JSON words/segments, completion state, speakers, errors, wordCount; writes `exports/full.txt` and returns `path` when prose exceeds `maxChars` |
| `export_run` | `{kind:"txt"|"json"|"audio",sessionFolder?}` | writes `exports/full.*`; returns absolute path + bytes |

`transcript_get` details:

- `format:"text"` (default) returns joined prose.
- `format:"json"` returns global-timecode `words` and `segments`.
- `corrected:true` (default) applies the AI-checkup projection when a checkup block exists;
  `corrected:false` returns the stored ASR words.
- `includeWords:true` adds a paginated `words` slice (`offset` default 0, `limit` default 2000,
  max 10000) plus `hasMore`.
- `complete` is false while chunks are pending/running; `errors` lists failed chunk indices.
- `speakers`/`diarization` reflect the stored diarization block (word speakers are derived).

## Media + speakers + settings

| Tool | Input | Returns |
| --- | --- | --- |
| `import_media` | `{mediaPath,parentDir?,name?}` | transcodes an audio/video file into a new session and starts transcription |
| `diarize_run` | `{}` | runs offline speaker diarization on the active finished session |
| `diarize_status` | `{}` | availability, binary/model, running folder |
| `settings_set` | allowlist: `lastSessionParent,chunkSec,engine,model,language,device,vad,diarizeAutoOnStop` | updates recording defaults; returns the allowlisted settings |

`settings_set` never accepts LLM API keys, the MCP token, or the port.

## Errors

Tool failures are returned with `isError: true` and a plain-text message, never a transport
error:

- `susurroLive UI is still starting; retry in a moment`
- `microphone permission denied` / `capture failed`
- `no screen source available for system audio`
- `recording is already active`
- `session already has chunks`
- `stop recording before ...`
- `transcription did not finish within ...`
- `401` from the HTTP layer means the bearer token is missing or rotated.
