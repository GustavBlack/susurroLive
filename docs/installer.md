# Installing & Updating susurroLive (Windows)

From **v1.4.0** susurroLive ships two Windows artifacts per release:

| Artifact | What it is | When to use |
| --- | --- | --- |
| `susurroLive-Setup-<version>.exe` | **NSIS installer** (primary) | Installing on a PC — Start Menu + desktop shortcuts, clean updates |
| `susurroLive-<version>-portable.exe` | Single portable exe (secondary) | USB sticks, no-install scenarios |

Both bundle the same payload: the app, `whisper-cli` (CUDA), the `small.en` model, the diarizer,
and ffmpeg. Everything else (larger whisper models, Parakeet) downloads on demand at runtime.

## Installing

1. Run `susurroLive-Setup-<version>.exe`.
2. Choose "Just me" (recommended — per-user install, **no admin rights needed**) or "Everyone"
   (per-machine, requires elevation; for shared machines).
3. Pick the install folder if you like (default `%LOCALAPPDATA%\Programs\susurroLive`).
4. Launch from the Start Menu or desktop shortcut.

> **SmartScreen note:** the build is not code-signed yet, so Windows SmartScreen shows
> "unknown publisher" on first run — click *More info → Run anyway*. Buying an Authenticode
> certificate removes this.

## Updating (in-app)

Installed builds check GitHub Releases ~30 s after launch (offline-safe; nothing happens without
a feed). When an update exists:

- A pill appears in the Settings drawer header: **"update <version> — download"**.
- Click it to download (progress on the pill). susurroLive never downloads updates without
  your click.
- The pill becomes **"restart to update"** — click to install and relaunch. The NSIS update
  runs silently in per-user mode.
- Updates are **differential**: only changed blocks transfer (blockmap), not the full ~1.5 GB.
- You can also check manually: the updater runs automatically, or trigger it by restarting the
  app.

**Never updates:** dev runs (`npm run dev`) and the portable exe — no feed is configured there.

### Update feed (public repo)

The Releases feed is **public** — the updater needs no token and no configuration. If you ever
build against a *private* fork, electron-updater accepts a read-only token via the `GH_TOKEN`
environment variable or a plain-text `gh-token` file at `%APPDATA%\susurroLive\gh-token`.

## Where your data lives (and why uninstall is safe)

- `%APPDATA%\susurroLive` — settings, session folders list, downloaded engines/models (Parakeet).
- Your **session folders** (transcripts + audio) live wherever you chose on first run — the app
  never moves or deletes them.

`deleteAppDataOnUninstall: false` — uninstalling removes the program, **not** your sessions or
settings. Reinstalling picks up where you left off.

## Migration from the portable exe

Nothing to do. Both flavors read the same `%APPDATA%\susurroLive`; install the Setup exe and
your sessions/settings appear as before. (Keep or delete the portable exe afterwards; it does
not conflict, but only the installed build receives update notifications.)

## For maintainers: release procedure

1. Bump `version` in `package.json` (this version is baked into artifact filenames + the feed).
2. `npm run dist` — builds installer + portable, then `scripts/check-release.js` **fails the
   build** unless all of these exist with matching versions:
   - `build/latest.yml` + `build/latest.yml.blockmap` (update feed)
   - `build/susurroLive-Setup-<version>.exe`
   - `build/susurroLive-<version>-portable.exe`
3. Create a GitHub release tagged `v<version>` on `GustavBlack/susurroLive` and attach all four
   artifacts. The updater serves whatever the **newest published release** advertises; older
   published releases are ignored by installed clients (version compare).
4. Unsigned note: `signtool` signs with a self-signed/test cert today; a real Authenticode cert
   slots into `win.certificateSubjectName`/`sign` config when purchased.
