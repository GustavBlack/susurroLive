# ADR 0008 — Local MCP agent control surface

- **Status:** Accepted
- **Date:** 2026-10-22
- **Applies to:** susurroLive 1.7

## Context

Every session folder already carries `AGENTS.md` and `session.json`, so agents can *read* a
recording without the app. What was missing was *control*: starting a recording, choosing its
destination, adding mic/system sources, and retrieving the transcript while the app is open.

The app is Electron: main owns session/pipeline truth, while microphone and system-loopback
capture live in the renderer (`CaptureEngine`, `getUserMedia`, `desktopCapturer`). A control
surface must not duplicate capture in main, and must not require a second app process.

Hermes Agent supports MCP servers over both stdio and HTTP (`mcp_servers` with `url` +
`headers`), and its skills are on-demand instructions plus optional scripts executed through a
shell. Native Windows Hermes runs its terminal through Git Bash and has PowerShell available.

## Decision

1. **Embed a stateless MCP server in the Electron main process.** Streamable HTTP, JSON
   responses (no SSE), no extra npm dependency. Endpoint `http://127.0.0.1:8790/mcp`.
2. **Loopback + bearer token.** Bind `127.0.0.1`, reject non-loopback `Host` and any browser
   `Origin`, require a 32-byte token from `%APPDATA%\susurroLive\mcp.json`, constant-time
   compare, 1 MiB body cap, 130 s request ceiling.
3. **Fixed tool allowlist.** Status/session/recording/transcription/export/import/diarize tools.
   No shell, no arbitrary write, no LLM keys.
4. **Renderer command channel.** Main sends a named operation (`recording.start/pause/resume/
   stop`, `sources.list`, `session.refresh`, `state.get`) over `evt:mcpCommand`; the renderer
   executes the same functions as the buttons and replies on `mcp:response`. Commands are
   allowlisted, never evaluated as JS.
5. **Recording profiles.** `meeting` = default mic + loopback, `voice` = mic only,
   `system` = loopback only, `custom` = explicit sources. `recording_start` also accepts the
   session parent folder and name, so one call creates the folder and starts capture.
6. **Two Hermes clients.** Native `mcp_servers` config for typed `mcp_susurro_*` tools, and a
   `susurro-live` skill + PowerShell helper that launches the app and calls the same endpoint
   with **no MCP registration**.
7. **Stateless transport.** No `Mcp-Session-Id`; each POST is independent. `GET`/`DELETE` on
   `/mcp` return 405. Protocol versions `2025-03-26`, `2025-06-18`, and `2025-11-25` are
   accepted; a `2026-07-28` client negotiates down to `2025-11-25`.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Stdio-only server | The app already runs a GUI and owns state in main; a stdio server would be a second process duplicating or proxying state. Hermes supports HTTP. |
| Move capture into main | `desktopCapturer` + Web Audio are renderer APIs; a rewrite with no product benefit. The window is present while the app is open. |
| Drive the UI with `executeJavaScript` | Brittle, untyped, and a much wider attack surface than named commands. |
| Raw `curl` from a Hermes skill | Quoting JSON, token handling, initialize, and error mapping would be re-implemented for every call. A helper script keeps one contract. |
| Mutate `settings` for per-recording sources | Sources are session data; `record:start` already persists `recording.sources`. |
| Bind `0.0.0.0` for remote agents | Recording is a local desktop capability; remote access would expose mic/screen control over the network. |

## Consequences

**Positive**

- Agents can operate the app immediately after it opens; the UI reflects every action.
- One implementation of session/export/import actions is shared by IPC and MCP.
- The session folder remains the no-server fallback contract.
- No new runtime dependency; the server is plain Node `http`.

**Negative**

- Capture requires the renderer; a minimized window is supported (`backgroundThrottling:false`),
  but a closed app or a crashed renderer cannot record.
- The bearer token is a local capability. Any process that can read the user's `%APPDATA%` can
  use it; OS user isolation is the boundary.
- The skill path uses shell/PowerShell, so it is Windows-local only and cannot run from a remote
  Docker/WSL backend. The native `mcp_servers` path is still available.
- Tool names/schemas are a compatibility surface; adding tools is additive, removing/renaming
  is breaking.

## Security notes

- Token never enters the renderer: `mcp:status` omits it, and `copyConfig` writes the YAML to the
  clipboard in main.
- Logs contain tool names/errors, never tokens or transcript text.
- Tool errors return `isError:true` text; protocol errors never include stack traces.
- `parentDir`, `sessionFolder`, and `mediaPath` are absolute; writes are confined to the chosen
  session's `exports/` (plus the session folder itself for new sessions).
- `settings_set` is allowlisted and cannot read or write LLM API keys or the MCP token.
