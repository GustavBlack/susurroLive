# ADR 0004 — Capture backend behind an interface

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

We need mic + **system loopback** (+ optional per-app) capture on Windows, with per-source gain,
mute, and live meters, feeding a mix bus. The Node ecosystem here is thin and young.

## Decision

Define a narrow **`CaptureBackend`** interface and implement it first with
**`native-audio-node`** (WASAPI, prebuilt N-API binaries).

```ts
interface CaptureBackend {
  listDevices(): Promise<Device[]>;                       // mic | loopback | app
  open(src: SourceConfig): AsyncIterable<PcmFrame>;       // 48 kHz PCM in
  close(id: string): Promise<void>;
}
```

A raw WASAPI N-API module (or `application-loopback` for per-app) can drop in later without touching
the mixer, chunker, or pipeline.

## Consequences

**Positive**
- Young-dependency risk is contained to one module behind an interface.
- Per-app capture can be added as a second backend, not a rewrite.

**Negative**
- We own the resampling/normalization contract at the backend edge (48 kHz, 16-bit PCM) so backends
  stay interchangeable.

## Alternatives rejected

- **PortAudio (`node-portaudio`)** — older, weaker maintenance; loopback coverage uncertain.
- **ffmpeg `dshow`/`wasapi` capture** — great for encoding/export, awkward for per-source live
  control and metering; kept for export only.
