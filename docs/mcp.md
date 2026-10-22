# Agent control (MCP)

susurroLive 1.7 ships a local **Model Context Protocol** server inside the app. When the app is
open, a local agent (Hermes Agent first) can start/stop recordings, choose the session folder,
add microphone/system sources by profile, wait for transcription, and read/export the
transcript — without launching anything else.

- **Endpoint:** `http://127.0.0.1:8790/mcp` (Streamable HTTP, JSON responses)
- **Auth:** bearer token from `%APPDATA%\susurroLive\mcp.json`
- **Scope:** local machine only (`127.0.0.1`); no cloud, no remote bind
- **Default:** enabled; Settings → Agents (MCP) has the kill switch, token rotation, and
  "Copy Hermes config"

The app must be running in the interactive Windows desktop session: microphone capture,
`desktopCapturer` loopback, and the UI all live in the renderer. A service/session-0 launch
cannot record.

## Setup

1. Open susurroLive.
2. Settings → **Agents (MCP)** → confirm **Allow local agents to control susurroLive** is on.
3. Click **Copy Hermes config**.
4. Paste it into `%LOCALAPPDATA%\hermes\config.yaml` (native Windows Hermes) under `mcp_servers`.
5. Start Hermes after susurroLive, or run `/reload-mcp`.

```yaml
mcp_servers:
  susurro:
    url: "http://127.0.0.1:8790/mcp"
    headers:
      Authorization: "Bearer <token>"
    timeout: 180
    supports_parallel_tool_calls: false
    tools:
      include:
        - app_status
        - sources_list
        - session_list
        - session_create
        - session_open
        - recording_start
        - recording_pause
        - recording_resume
        - recording_stop
        - recording_status
        - transcription_wait
        - transcription_retry
        - transcript_get
        - export_run
        - import_media
        - diarize_run
        - diarize_status
        - settings_set
      resources: false
      prompts: false
```

Hermes registers the tools as `mcp_susurro_<tool>` (for example
`mcp_susurro_recording_start`).

### Skill path (no MCP registration)

If you do not want an `mcp_servers` entry, install the **`susurro-live-mcp`** skill from
`integrations/hermes/susurro-live-mcp/` into
`%LOCALAPPDATA%\hermes\skills\audio\susurro-live-mcp\` (or `hermes skills install <path>`). The
packaged app also ships a copy at `resources\hermes-skill\susurro-live-mcp\`. The skill uses
`scripts/susurro.ps1` to launch the app and call the same MCP endpoint. It is native Windows only
and requires the `terminal` toolset.

**Keep the `-mcp` suffix.** This skill drives a *running* app; a source-maintenance skill for the
repo usually lives as `susurro-live`. Two Hermes skills declaring the same `name:` cannot both
load — one silently shadows the other and the shadowed one becomes unreachable — so install this
one under its own name and leave the directory and frontmatter `name` in sync.

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/path/to/susurro-live-mcp/scripts/susurro.ps1 ensure
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/path/to/susurro-live-mcp/scripts/susurro.ps1 start -Profile meeting -Parent D:\Sessions -Name "Weekly Sync"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/path/to/susurro-live-mcp/scripts/susurro.ps1 stop -Wait
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/path/to/susurro-live-mcp/scripts/susurro.ps1 transcript
```

## Tools

| Tool | Purpose |
| --- | --- |
| `app_status` | readiness, MCP endpoint, GPU/engines, current session, recording/pipeline state |
| `sources_list` | microphones, loopback screens, current sources, profiles |
| `session_list` / `session_create` / `session_open` | browse and activate sessions |
| `recording_start` | create/reuse a session and start capture; `profile=meeting/voice/system/custom` |
| `recording_pause` / `recording_resume` / `recording_stop` | transport; stop optionally waits for transcription |
| `recording_status` | live duration/sources/chunks/pipeline |
| `transcription_wait` / `transcription_retry` | drain or retry the chunk queue |
| `transcript_get` | prose or timecoded words; corrected projection by default |
| `export_run` | writes `exports/full.txt`, `full.json`, or `full.wav` |
| `import_media` | transcode an audio/video file into a session |
| `diarize_run` / `diarize_status` | offline speaker identification |
| `settings_set` | recording defaults only (never LLM keys or the MCP token) |

### Recording profiles

- **meeting** — default microphone + system loopback (WASAPI "what you hear")
- **voice** — default microphone only
- **system** — system loopback only
- **custom** — explicit `sources` array; at most one loopback source

`recording_start` accepts `parentDir` (absolute) and `name`; the app creates the timestamped
session folder, adds the sources, and starts capture. If the active session already has chunks,
a new session is created by default. `newSession:false` reuses an empty active session and fails
if it already has chunks.

### Transcript retrieval

`transcript_get` defaults to the active session. Pass `sessionFolder` to read an old session
without changing the UI. `format:"text"` returns prose; `format:"json"` returns global-timecode
`words` and `segments`. `corrected` defaults to true and matches the app/export projection when
an AI-checkup block exists. Large prose is written to `exports/full.txt` and returned as a
truncated preview plus `path`.

## Security model

- Bind `127.0.0.1` only; reject non-loopback `Host` headers (DNS-rebinding guard) and any
  browser `Origin` header.
- Require `Authorization: Bearer <token>` on every MCP POST. 32 random bytes; constant-time
  compare; rotate from Settings.
- Token lives in `%APPDATA%\susurroLive\mcp.json`, not in `settings.json`; it is never exposed
  to the renderer, logs, or tool output.
- 1 MiB request body cap, 15 s header timeout, 130 s request ceiling (waits clamp to 120 s).
- Tools are a fixed allowlist. There is no shell/exec tool, no arbitrary file write, and no LLM
  key access. `parentDir`/`sessionFolder`/`mediaPath` are absolute-path inputs; the app reads
  `session.json` and writes only inside the chosen session folder's `exports/`.
- An agent with the token can start/stop recordings and read transcripts. That is the point;
  disable Settings → Agents (MCP) or rotate the token to revoke.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Hermes cannot connect | Open susurroLive first, then start Hermes or run `/reload-mcp` |
| `401` | Token rotated; copy a fresh Hermes config from Settings |
| `port 8790 is already in use` | Quit the other app/process using the port, or change `mcpPort` in settings and update the agent config |
| `renderer not ready` | Wait for the app window to finish booting, then retry |
| mic permission denied | Windows Settings → Privacy → Microphone → allow desktop apps |
| no system audio | No screen source available, or the default output device has no loopback |
| no transcript yet | Call `recording_stop {waitForTranscription:true}` or `transcription_wait`; check `errors` |
| skill cannot launch | Set `SUSURRO_APP_PATH` or pass `-AppPath` to `susurro.ps1`; native Windows only |

The session folder remains the portable, no-server contract: `session.json` + `AGENTS.md` +
`audio/` + `transcripts/`. An agent can always read those files directly even when MCP is off.
