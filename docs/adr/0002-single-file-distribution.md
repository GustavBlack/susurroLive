# ADR 0002 — Single-file portable distribution

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

The app must be "extremely portable: a single-file EXE containing all of its own dependencies" —
droppable on any Windows machine and runnable, with no installer and no prerequisites beyond the OS.

## Decision

Use **Electron** for the shell and **electron-builder's `portable` target** for packaging.

- `electron-builder -w --config electron-builder.yml` with `target: portable` produces **one `.exe`**
  that self-extracts to a temp dir and runs.
- Native payload (whisper sidecar, capture `.node`, ffmpeg) ships via **`extraResources`** into
  `resources/` (outside ASAR), and native `.node` modules are **`asar.unpack`**ed.
- Runtime paths resolve via **`process.resourcesPath`**, never `__dirname` inside ASAR.

## Why not the alternatives

| Option | Why not |
| --- | --- |
| Tauri | Smaller, but the audio + sidecar work is C++/Rust-heavy and the warm-ink UI/animation story is easier in Electron; team familiarity favors Electron. |
| NW.js | No meaningful advantage over Electron here. |
| .NET/WPF | Would mean reimplementing the whole capture + whisper pipeline; loses cross-tooling. |
| Installer (NSIS/MSI) | Violates "single file, no install". |

## Consequences

**Positive**
- Literally one file to hand someone.
- Native binaries run outside ASAR (no `Dynamic Linking Error: Win32 error 126`).

**Negative**
- Portable exe is large (Electron runtime + model if bundled).
- First launch pays an extraction cost.
- Antivirus/SmartScreen may flag an unsigned portable exe → plan code signing.

## Open sub-decision

**Bundle the default model in the exe, or download on first launch?**
- Bundle: +~470 MB, works fully offline out of the box.
- Download: lean exe, needs one-time network for the default model.
Recorded in `PLAN.md §3`; default proposal = **bundle `small.en`, download `large-v3-turbo`**.
