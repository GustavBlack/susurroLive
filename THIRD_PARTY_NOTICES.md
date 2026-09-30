# Third-Party Notices

susurroLive incorporates and redistributes the third-party components listed below.
This project is licensed under the BSD 3-Clause License (see `LICENSE`); the components
keep their own licenses, reproduced or linked in the `licenses/` folder.

## Components

### Electron
- **Role:** application framework (main process, windowing, updater host)
- **License:** MIT — https://github.com/electron/electron/blob/main/LICENSE
- **Home:** https://www.electronjs.org/

### electron-builder & electron-updater
- **Role:** packaging (NSIS installer, portable target) and in-app delta updates
- **License:** MIT — https://github.com/electron-userland/electron-builder/blob/master/LICENSE

### whisper.cpp (whisper-cli.exe + ggml*.dll)
- **Role:** primary speech-to-text sidecar (CUDA and CPU builds)
- **License:** MIT — https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE
- **Home:** https://github.com/ggml-org/whisper.cpp
- Note: ggml (bundled as `ggml*.dll`) is MIT, part of the whisper.cpp repository.

### Whisper ggml models
- **Bundled:** `ggml-small.en.bin`; all other models download on demand.
- **Source:** https://huggingface.co/ggerganov/whisper.cpp
- **License:** MIT. The converted ggml weights inherit the MIT license of the whisper.cpp
  model distribution (original Whisper model: Copyright OpenAI, MIT-licensed at
  https://github.com/openai/whisper).

### sherpa-onnx (sherpa-onnx-offline.exe, provisioned in-app)
- **Role:** ONNX speech-to-text runtime for the Parakeet engine (downloaded on demand,
  never bundled)
- **License:** Apache-2.0 (`licenses/Apache-2.0.txt`)
- **Home:** https://github.com/k2-fsa/sherpa-onnx

### parakeet-tdt-0.6b-v3 (int8 ONNX, provisioned in-app)
- **Role:** multilingual speech-to-text model for the Parakeet engine
- **Copyright:** © NVIDIA Corporation
- **License:** CC-BY-4.0 (`licenses/CC-BY-4.0.txt`) — https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- The app downloads this model at runtime from the k2-fsa/sherpa-onnx model release
  (a conversion of the NVIDIA model above); the conversion retains the CC-BY-4.0 license.

### NeMo-Speech.cpp (bin/diarizer/nemo-speech.exe + ggml*.dll, built from source)
- **Role:** speaker-diarization sidecar
- **Copyright:** © 2026 NVIDIA CORPORATION & AFFILIATES
- **License:** Apache-2.0 (`licenses/Apache-2.0.txt`)
- **Home:** https://github.com/NVIDIA/NeMo-Speech.cpp
- Built pinned to upstream commit `97a15af` with a local CPU-threads patch
  (`scripts/patches/nemo-speech-cpu-threads.patch`). Upstream requires its NOTICE and
  third-party notices to accompany distributions of its code; NVIDIA's project copyright
  notice is retained here accordingly.

### Nemotron-3-Diarization (q8_0 GGUF, bundled)
- **Role:** speaker-diarization model consumed by NeMo-Speech.cpp
- **Copyright:** © NVIDIA Corporation
- **License:** OpenMDW License Agreement, version 1.1 — full text in
  `licenses/OpenMDW-1.1.txt` (retained in this distribution as its terms require).
- **Source:** https://huggingface.co/nvidia/Nemotron-3-Diarization

### FFmpeg (ffmpeg.exe, ffprobe.exe + av*/sw* DLLs)
- **Role:** media decoding for file import
- **License:** LGPL-3.0-or-later (`licenses/LGPL-3.0.txt`)
- **Home:** https://ffmpeg.org
- **Source:** the binaries bundled with susurroLive releases are unmodified builds of
  FFmpeg master from BtbN's FFmpeg-Builds ("lgpl-shared" variant). The corresponding
  source is available at https://github.com/BtbN/FFmpeg-Builds (build scripts) with
  FFmpeg's own source at https://git.ffmpeg.org/ffmpeg.git. These libraries are
  dynamically linked and shipped unmodified, satisfying LGPL relinking requirements;
  they may be replaced or upgraded independently of the application.
- FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

### Microsoft Visual C++ Runtime (msvcp140.dll, vcruntime140.dll, vcruntime140_1.dll, vcomp140.dll)
- **Role:** application-local CRT + OpenMP runtime for the diarizer sidecar
- **License:** Microsoft Software License Terms for the Visual C++ Redistributable —
  redistribution in unmodified form alongside an application is permitted by those terms.
- **Source:** https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist

### NVIDIA CUDA runtime libraries (cudart, cuBLAS, cuDNN — bundled with the CUDA build)
- **Role:** GPU acceleration for whisper.cpp
- **License:** NVIDIA software license terms permitting redistribution of the runtime
  binaries with applications (see the notices inside each DLL or the CUDA EULA at
  https://docs.nvidia.com/cuda/eula/).

## Notes for forks

If you fork susurroLive, keep this file and the `licenses/` folder with any distribution
of the application or of the bundled models (the OpenMDW and CC-BY-4.0 model licenses
require the license text and notices of origin to be retained). Components marked
"provisioned in-app" are downloaded at runtime from their upstream projects; pointing
the download at different artifacts does not remove your obligation to pass their
licenses through.
