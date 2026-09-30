# GPU / CUDA Detection & Fallback

Requirement: **use a CUDA GPU when present (fast); warn the user when we fall back to CPU (slow).**

## Detection at startup

```ts
type GpuInfo = {
  vendor: "NVIDIA" | "AMD" | "Intel" | "none";
  model: string;          // "NVIDIA GeForce RTX 5090"
  cuda: boolean;          // CUDA-capable + usable
  compute: string | null; // "12.0"
  vramMb: number | null;
  chosen: "cuda" | "cpu";
};
```

Probe order:
1. **`nvidia-smi --query-gpu=name,compute_cap,memory.total --format=csv,noheader`**
   → authoritative for NVIDIA: presence, name, compute capability, VRAM.
2. **`systeminformation`** (Node lib) → broader coverage (AMD/Intel) for the report + UI.
3. Fall back to **`dxdiag`/WMI** if neither is available.

Then reconcile with **what the whisper binary was actually built with**: if whisper.cpp lacks CUDA
support, force `chosen = "cpu"` regardless of the hardware, and say so.

## Upholding the promise (build archs)

The sidecar must be built with CUDA enabled **and** the right compute architectures, or the GPU is
silently ignored:

```powershell
cmake -B build -DGGML_CUDA=1 -DCMAKE_CUDA_ARCHITECTURES="75;80;86;89;120"
cmake --build build -j --config Release --target whisper-cli
```

- `75` Turing · `80/86` Ampere · `89` Ada · **`120` Blackwell (RTX 50-series, incl. the RTX 5090)**.
- Building a spread keeps one binary portable across the studio's machines.
- ⚠️ The whisper.cpp README's "RTX 5000 series → arch 86" example is **wrong/misleading** — Blackwell
  is **120**. Verifying this is a Phase-1 smoke-test gate.

## Runtime behavior

| State | Behavior | UI |
| --- | --- | --- |
| NVIDIA + CUDA build | transcribe on GPU | green pill "GPU · RTX 5090 (CUDA)" |
| No CUDA GPU | transcribe on CPU | amber banner: "No CUDA GPU — using CPU. Transcription will be slower." |
| CUDA build but OOM | per-chunk CPU retry | inline "retrying on CPU" on that chunk |
| Driver too old | fall back + explain | "NVIDIA driver too old for CUDA build — update to use GPU." |

The banner appears once at first record (dismissible, remembered) and lives permanently in Settings.

## Memory management

- **GPU:** one worker → one model resident at a time (~0.5 GB for `small.en`, ~1.5 GB for
  `large-v3-turbo`). Freed when the worker exits.
- **CPU:** bounded worker count (`min(4, cores/2)`); model load happens per worker process, so a
  large model × many workers is a RAM risk → cap by available RAM, not just cores.
- **Buffers:** the mix ring buffer is fixed-size; chunks stream straight to disk. Nothing
  proportional to session length is held in RAM except the growing word array (small: ~1 word ≈ 50 B;
  10 h of speech ≈ a few MB — fine).
- **v2:** resident-model wrapper removes per-chunk load/teardown churn and pins one model.

## Verifying on the target machine

`scripts/verify-gpu.ps1` emits `GpuInfo` JSON; `scripts/smoke-transcribe.ps1` runs the sidecar on a
fixture and asserts (a) word timestamps are present and (b) `system_info:` reports CUDA when a GPU
is expected. Both are prerequisites for tagging a release.
