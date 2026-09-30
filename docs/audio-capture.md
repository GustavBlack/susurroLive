# Audio Capture — Mix Bus & Chunker

The requirement: **an array of sources, mixed into one stream, with per-track mute, live meters,
and chunked output.**

## Library choice

| Option | Verdict |
| --- | --- |
| **`native-audio-node`** (v0.3.5) | ✅ **Primary.** Prebuilt N-API binaries (no build tools), mic **and** system loopback **and** per-process capture, resampling, device enumeration, Windows 10 2004+. |
| `loopback-capture` / `application-loopback` | Good fallback for per-app capture (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`). |
| PortAudio (`node-portaudio`) | Older, maintenance risk. Avoid. |
| ffmpeg `dshow`/`wasapi` | Keep ffmpeg for **encoding/export**, not live capture. |

> Risk note: `native-audio-node` is young (v0.3.x, low download count). Mitigation: isolate it
> behind a `CaptureBackend` interface so a raw WASAPI N-API module can drop in without touching the
> rest of the app. The interface is the contract; the implementation is replaceable.

## Source kinds

| Kind | API | Notes |
| --- | --- | --- |
| `mic` | WASAPI capture (default or chosen device) | Windows may prompt for mic privacy consent. |
| `loopback` | WASAPI loopback on the default **render** device | "What you hear" — headphones or speakers. Silent when nothing plays → use `emitSilence:true`. |
| `app` | WASAPI process loopback | Windows only supports **one PID per stream** → one source per app. |

## Mix bus

```
src_mic  ──► [gain] ─┐
src_sys  ──► [gain] ─┤──► Σ ──► ring buffer (48 kHz, stereo) ──► Chunker
src_app  ──► [gain] ─┘                │
(muted → gain 0,                      └──► LevelMeter (pre-mute, per source)
 excluded from Σ)
```

Rules:
1. **Sample rate is normalized to 48 kHz** at the source edge (the lib resamples). One rate
   downstream = no drift math in the mixer.
2. **Mute = gain 0 in the sum**, but the source keeps streaming to its own meter so the user can
   still *test* a muted feed. (This is a product requirement: "test the feed from the different
   sources as they add them.")
3. **Meters are computed pre-mute**, throttled to ~30 Hz, and shipped to the renderer for the
   right-rail visualizer.
4. **The shipped Electron capture uses PCM sample counts for timing.** The Web Audio mix sends
   mono PCM16 buffers at the AudioContext rate (48 kHz preferred). Pause disables source audio
   tracks and gates PCM in both capture and main; paused time adds no silence to the recording.

### Mixer maths (v1)

Simple sum with headroom:
```
mixed[i] = clamp( Σ_s (gain_s × src_s[i]) , -1, 1 )
```
Optionally apply a soft limiter later if clipping shows up with many loud sources. Keep a per-source
peak meter visible so the user can trim gains manually. (Auto-gain is a v2 nicety.)

## Chunker

- **Window:** `chunkSec` (default 30).
- **Trigger:** sample count → closes `audio/chunk_NNNN.wav`; the next PCM opens the next file.
- **Alignment:** full chunks are sample-exact, even when a buffer crosses a boundary.
  Pause/Stop close partial chunks. `offsetSec` is cumulative captured samples / sample rate,
  never index × chunkSec. This keeps playback aligned after any number of pauses.
- **Format:** WAV, 48 kHz preferred, mono, 16-bit PCM. (whisper.cpp resamples to 16 kHz mono internally —
  we don't pay for a resampler in the record path.)
- **On close:** set the chunk `done` on disk with status `pending`, emit `chunk:closed`.

### Edge cases

| Case | Handling |
| --- | --- |
| Stop mid-chunk | close the partial chunk, record its true `durationSec`, enqueue it. |
| Pause/resume | close and queue the current chunk; keep the session; ignore paused PCM; resume at the cumulative sample offset. |
| Disk full | halt capture, surface a hard error, keep the session valid with chunks so far. |
| Device unplugged | drop that source, keep the mix alive with the rest, warn in UI. |

## Level metering for the visualizer

Emit per source at ~30 Hz:
```ts
type Levels = Record<string /*sourceId*/, { rms: number; peak: number }>;
```
The renderer turns `rms` into bar/square heights with attack/release smoothing (fast attack, slow
release) so the animation feels musical rather than jittery.

## Test mode

Each source row has a **Test** action: plays its live level into the visualizer **without**
recording and **without** it entering the mix, so the user can confirm a source before they commit
it to the array.
