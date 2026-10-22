---
name: susurro-live-mcp
description: Use when driving the running susurroLive app (record, stop, transcript, export, import, diarize) through its local MCP endpoint — skill path, no mcp_servers entry.
version: 0.2.0
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

# susurroLive — MCP control skill

Control the **local** susurroLive recording studio without adding an `mcp_servers` entry to
Hermes. The skill launches the app if needed, then calls the app's embedded MCP endpoint through
a PowerShell helper.

- The app must run in the **interactive Windows desktop session** (mic/loopback capture needs it).
- The helper reads `%APPDATA%\susurroLive\mcp.json` for the endpoint and bearer token.
- Never print, echo, or pass the token to any other command. The helper never prints it.

## Name: `susurro-live-mcp`, and why

This skill is deliberately **not** named `susurro-live`. A development/maintenance skill for the
app's source tree commonly goes by `susurro-live`; two skills with the same `name:` cannot both be
loaded (one silently shadows the other, and `skill_view` cannot address the loser). Keep the
suffix:

- MCP control of a running app → **`susurro-live-mcp`** (this skill)
- Editing the app's source → `susurro-live` (if the user has such a skill)

Install to `%LOCALAPPDATA%\hermes\skills\audio\susurro-live-mcp\`. Do not rename it to
`susurro-live` when copying, and do not edit `name:` — the directory name and the frontmatter
`name` must stay identical.


## When to Use

Use this skill when the user asks to:

- start, pause, resume, or stop a recording
- capture a meeting (microphone + system audio), a voice memo (microphone only), or system audio
- set where a recording should live, or name the session
- wait for transcription and return/read/export the transcript
- import an audio/video file into a session
- identify speakers in a finished session

## Procedure

Run commands from Git Bash through PowerShell. The script lives next to this file; use its
absolute path with forward slashes (MSYS path translation is off for native tools on this host):

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File "C:/Users/<you>/AppData/Local/hermes/skills/audio/susurro-live-mcp/scripts/susurro.ps1" ensure
```

Every example below shows the subcommand only; prefix each with
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<absolute path to susurro.ps1>"`.
Pass native `D:\...` paths in single quotes from bash.

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
- **`start -Parent …` is persistent, not scoped** — it writes `lastSessionParent` into the app's
  `settings.json`, so later sessions default there. Mention it, or restore the previous parent.
- **Chunk count follows the user's `chunkSec`** (1 s in a default test setup), so an 8 s clip can
  report ~12 chunks. That is not an error.
- **Two skills, one name, is impossible** — if the user also keeps a `susurro-live` development
  skill, install this one as `susurro-live-mcp`; do not rename the directory or `name:` to match
  the dev skill.

## Verification

- `ensure` prints `renderer ready: True` and a listening MCP URL.
- `start` prints the created session folder and `sources: mic:...` (and `loopback:...` for
  `meeting`).
- `status` shows `recording: recording` and a rising duration.
- `stop -Wait` prints `transcription complete: True`.
- `transcript` returns prose; `transcript -Format json` returns a positive `wordCount`.
- The session folder contains `session.json`, `audio/`, `transcripts/`, and `exports/`.

For exact tool inputs/outputs, load `references/tools.md` or run `tools -Json`.
