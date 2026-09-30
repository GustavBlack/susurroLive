# Warm Ink — Style Tokens for susurroLive

Extracted from `Warm-Ink-Style-Bible.html` (base) and `Warm-Ink-Atari-Edition.html` (chromatic
variant). susurroLive uses the **base Warm Ink** palette with the Atari edition's amber/ochre
accents as the "active/record" family.

## Palette (base — from source)

| Token | Hex | Role |
| --- | --- | --- |
| `--ink-000` | `#121212` | deepest background |
| `--ink-050` | `#131514` | app background |
| `--ink-100` | `#181A19` | panel background |
| `--ink-150` | `#1F201F` | raised surface |
| `--ink-200` | `#232523` | surface hover |
| `--ink-250` | `#2A2C2A` | card |
| `--ink-300` | `#2E2E2B` | elevated card |
| `--line`    | `#454442` | borders / hairlines |
| `--muted`   | `#726B68` | secondary text |
| `--muted-2` | `#A99E98` | tertiary text / icons |
| `--paper`   | `#D8D0CB` | primary text (warm cream, not white) |
| `--paper-hi`| `#EDE8E5` | headings |
| `--paper-2` | `#F5F1EE` | highest emphasis |
| `--accent`  | `#C99A6B` | **primary accent** (warm amber/tan) |

## Accents (record / active / state)

| Token | Hex | Use |
| --- | --- | --- |
| `--amber`   | `#B07A52` | recording / live |
| `--ochre`   | `#A8914A` | secondary accent |
| `--rust`    | `#9E5A52` | stop / error |
| `--sage`    | `#8A8E76` | processing / queued |
| `--moss`    | `#9CAF9C` | success / done |
| `--sage-2`  | `#C2D1B8` | success text |

## Text selection

Source uses `hsla(30,47%,60%,.2)` ≈ `#C99A6B` at 20% — keep it.

## Type

| Role | Stack | Notes |
| --- | --- | --- |
| UI / body | `Inter, system-ui, -apple-system, "Segoe UI", sans-serif` | 13–16 px body, weight 400/500 |
| Mono / timecode / transcript meta | `"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace` | timestamps, chunk ids, settings values |
| Display (optional) | `"VT323", monospace` (Atari edition) | sparingly — status numerals, not body |

Line-heights in source: 1.5 / 1.6 / 1.7 (reading), 1.1–1.15 (display). Transcript body should sit
at **1.7** for comfortable reading.

## Space & shape

- Radius: `8px` cards, `6px` controls, `999px` pills.
- Hairline borders in `--line`, 1 px; no heavy shadows — depth comes from surface steps, not blur.
- Section rhythm: 12 / 16 / 24 px.

## Motion

- **Add-source row:** fade + rise 8 px + slight scale (0.98 → 1), 180 ms `cubic-bezier(.2,.7,.2,1)`.
- **Record button:** pulsing ring in `--amber` (scale 1 → 1.06, opacity 0.6 → 0), 1.6 s loop.
- **Equalizer squares:** fast attack (~40 ms), slow release (~300 ms); height from `rms`, brightness
  from `peak`. Prefers-reduced-motion → static bars.
- **Word highlight (karaoke):** background `--amber` @ ~18% fading over 220 ms as the word passes.

### v1.2 visualizer motion (see `docs/v1.2-animations.md`)

- **Idle rotation:** eight light fields on a per-field schedule (14–22 s dwell, 4 s cross-dissolve,
  fixed order, no adjacent repeats): woven folds · ink in water · diagonal weave · aurora curtain ·
  ripples · wandering ring · ember drift · tide.
- **Reading current:** human scrolling of the transcript injects signed velocity
  (`viz.setScrollVelocity`); the grid brightens with directional streaks (fast attack ~50 ms,
  release ~0.9 s) and exhales back to the plain field. Idle/paused only; disabled under reduced
  motion; programmatic karaoke scrolling never drives it.
- **Import wavefront:** with progress fed, the import currents fill bottom-up; above the line a
  dim creep shimmer keeps the grid alive. Completion = one top-to-bottom moss wash (~1.4 s).
- **Chunk heartbeat:** every finished chunk sends a soft band down the grid (~2.5 s, moss); errors
  pulse rust. Overlay only — never a mode change.
- **Ignition:** the first 0.8 s of capture sweeps accent bottom-up before levels take over.
- **CSS accents:** static `feTurbulence` film grain on the app background (~5%, never animated);
  running chunk chips shimmer via `background-position` (replaces the opacity blink); the DEMO
  banner carries slow caution stripes so placeholder output is unmistakable.

## The right-rail visualizer

A vertical column (or 2-D grid) of **squares** — the one place the Atari edition's blockiness is
allowed in. Each column maps a source (or a frequency band of the mix); square size/opacity animate
to level. Muted sources render in `--muted` with a strike/dim so the "array" state is readable at a
glance.

```
 ▮▮  ▮▮▮  ▮    ▮▮▮▮
 ▮▮▮ ▮    ▮▮   ▮
 ▮   ▮▮▮  ▮▮▮  ▮▮      ← squares breathe with the mix
 ▮▮  ▮    ▮▮   ▮▮▮
```

## Layout (portrait tablet, ~4:5)

```
┌──────────────────────────────────────────────┐
│ ● susurroLive    Weekly Sync    [Idle]   ⚙   │  header
├──────────────────────────────────────────────┤
│  ◉ Record   chunk 30s   📁 ~/Sessions/…      │  transport
├───────────────────────────────────┬──────────┤
│  SOURCES                          │          │
│  🎙 Shure MV7      ▮▮▮▮  [test]  │  LIVE    │
│  🔊 System Audio   ▮▮    [mute]  │  ▮▮▮▮    │  source array
│  + Add source                     │  ▮▮      │  + visualizer
├───────────────────────────────────┤  ▮▮▮▮    │
│  TRANSCRIPT                       │  ▮▮      │
│  00:00:42  Okay so let's start…   │          │
│  …word-word karaoke follows play… │  ▮▮▮     │
│                                   │          │
├───────────────────────────────────┴──────────┤
│  ✓✓✓◐····   chunks        [txt][json][audio] │  pipeline + export
└──────────────────────────────────────────────┘
```

Default window: **820 × 1040** (ratio ≈ 0.79, portrait tablet, "vertical but not narrow").
Resizable; min ≈ 680 × 880.

## Tokens file

Drop-in CSS custom properties live at `src/renderer/theme/tokens.css` (created in Phase 0).
