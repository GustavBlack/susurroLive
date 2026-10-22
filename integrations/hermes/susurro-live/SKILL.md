---
name: susurro-live
description: Record and transcribe with susurroLive through its local MCP endpoint
version: 0.1.0
platforms: [windows]
metadata:
  hermes:
    tags: [audio, recording, transcription, mcp, windows]
    category: audio
    requires_toolsets: [terminal]
    config:
      - key: susurro.app_path
        description: Path to susurroLive.exe
        default: "%LOCALAPPDATA%\\Programs\\susurroLive\\susurroLive.exe"
      - key: susurro.sessions_dir
        description: Default parent folder for recordings (optional)
        default: ""
---

# susurroLive

Control the **local** susurroLive recording studio without adding an `mcp_servers` entry to
Hermes. The skill launches the app if needed, then calls the app's embedded MCP endpoint through
a PowerShell helper.

- The app must run in the **interactive Windows desktop session** (mic/loopback capture needs it).
- The helper reads `%APPDATA%\susurroLive\mcp.json` for the endpoint and bearer token.
- Never print, echo, or pass the token to any other command. The helper never prints it.

## When to Use

Use this skill when the user asks to:

- start, pause, resume, or stop a recording
- capture a meeting (microphone + system audio), a voice memo (microphone only), or system audio
- set where a recording should live, or name the session
- wait for transcription and return/read/export the transcript
- import an audio/video file into a session
- identify speakers in a finished session

## Procedure

Run commands from Git Bash through PowerShell. The script lives next to this file:

```bash
PS="powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"$(dirname "$0")/scripts/susurro.ps1\""
```

If the installed app path differs from the default, set `SUSURRO_APP_PATH` or pass `-AppPath`.
`skills.config.susurro.app_path` is the declared setting; read it with
`hermes config get skills.config` and pass it when present.

1. **Ensure the app is reachable.** This launches susurroLive if it is not running and waits up
   to 30 seconds for `rendererReady`.
   ```bash
   "$PS" ensure
   ```
   If it reports that the app is running but MCP is unreachable, tell the user to enable
   **Settings → Agents (MCP)**; do not start a second instance.

2. **Check sources (optional).** Microphones, loopback screens, current sources, and profiles.
   ```bash
   "$PS" sources
   ```

3. **Start recording.** Use an absolute parent folder when the user names one.
   ```bash
   "$PS" start -Profile meeting -Parent "D:\Sessions" -Name "Weekly Sync"
   ```
   Profiles: `meeting` (default microphone + system loopback), `voice` (default mic only),
   `system` (loopback only). For a custom source array use
   `raw -Tool recording_start -ArgsJson '{"profile":"custom","sources":[...],"parentDir":"..."}'`.
   The session folder is timestamped and printed.

4. **Check progress.** `recording_status` (also reports chunk/pipeline state).
   ```bash
   "$PS" status
   ```

5. **Pause/resume** if asked:
   ```bash
   "$PS" pause
   "$PS" resume
   ```

6. **Stop and wait for transcription.** `-Wait` blocks until all chunks are done/error
   (default 120 s; use `-TimeoutSec` to change).
   ```bash
   "$PS" stop -Wait
   ```

7. **Read the transcript.** Default `text`; use `-Format json` for timecoded words/segments.
   ```bash
   "$PS" transcript
   "$PS" transcript -Format json -Folder "D:\Sessions\2026-10-22_143022_Weekly-Sync"
   ```

8. **Export** `.txt`, `.json`, or audio:
   ```bash
   "$PS" export -Kind txt
   ```

Other commands:

| Command | Purpose |
| --- | --- |
| `sessions` | list sessions under the app sessions root (or `-Parent`) |
| `wait` | wait for transcription without stopping |
| `import -MediaPath "D:\media\interview.mp4"` | transcode media into a session |
| `diarize` | identify speakers on the active finished session |
| `tools -Json` | live tool list + descriptions |
| `raw -Tool <name> -ArgsJson '<json>'` | call any tool directly |

All commands accept `-Json` for machine-readable output.

## Rules

- **Ask before recording** unless the user's request already explicitly asks to start a
  recording. Report the session folder and resolved sources afterward.
- Use **absolute paths** for `-Parent`, `-Folder`, `-MediaPath`.
- `stop` without `-Wait` returns immediately; the transcription tail may still be running.
  Use `-Wait` or `wait` before claiming the transcript is complete.
- Do not invent transcript text. If `transcript.complete` is false, report that transcription
  is still running and call `wait`.
- Never print the bearer token. Never copy `mcp.json` into chat.
- One recording at a time. `recording_start` fails when a recording is already active.
- The app's UI is the source of truth; the helper only drives the same actions as the buttons.

## Pitfalls

- **401 / token errors**: the token was rotated. Re-read `%APPDATA%\susurroLive\mcp.json`
  (or copy the new Hermes config from Settings). Do not guess a token.
- **App running, MCP unreachable**: Settings → Agents (MCP) may be disabled, or port 8790 is
  occupied. The helper refuses to launch a second instance.
- **Microphone permission denied**: Windows blocked mic access. Ask the user to allow it in
  Settings → Privacy → Microphone, then retry.
- **No session folder**: pass `-Parent`; the app needs a sessions root.
- **Chunks under 1 s** are skipped by the transcription pipeline (reported as `skipped`);
  this is expected for very short pauses/stops.
- **PowerShell execution policy**: the helper is invoked with `-ExecutionPolicy Bypass`;
  never require administrator rights.
- **Remote/WSL/Docker terminal backend**: unsupported. Use native Windows Hermes on the same
  machine as the app.

## Verification

- `ensure` prints `renderer ready: True` and a listening MCP URL.
- `start` prints the created session folder and `sources: mic:...` (and `loopback:...` for
  `meeting`).
- `status` shows `recording: recording` and a rising duration.
- `stop -Wait` prints `transcription complete: True`.
- `transcript` returns prose; `transcript -Format json` returns a positive `wordCount`.
- The session folder contains `session.json`, `audio/`, `transcripts/`, and `exports/`.

For exact tool inputs/outputs, load `references/tools.md` or run `tools -Json`.
