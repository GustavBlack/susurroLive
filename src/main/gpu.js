'use strict';
/**
 * GPU / CUDA detection.
 * Probe order: nvidia-smi (authoritative) -> WMI display adapter fallback.
 */
const { execFileSync } = require('child_process');

function probeNvidiaSmi() {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=name,compute_cap,memory.total,driver_version', '--format=csv,noheader'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    ).trim();
    if (!out) return null;
    const line = out.split(/\r?\n/)[0];
    const [name, compute, vram, driver] = line.split(',').map((s) => s.trim());
    return {
      vendor: 'NVIDIA',
      model: name || 'NVIDIA GPU',
      cuda: true,
      compute: compute || null,
      vramMb: vram ? Number(String(vram).replace(/[^\d]/g, '')) || null : null,
      driver: driver || null,
    };
  } catch {
    return null;
  }
}

function probeWmi() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command',
        "Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name"],
      { encoding: 'utf8', timeout: 10000, windowsHide: true },
    ).trim();
    if (!out) return null;
    const vendor = /AMD|Radeon/i.test(out) ? 'AMD' : /Intel/i.test(out) ? 'Intel' : 'unknown';
    return { vendor, model: out, cuda: false, compute: null, vramMb: null, driver: null };
  } catch {
    return null;
  }
}

/**
 * @param {{ binaryCuda?: boolean }} opts  whether the whisper sidecar was built with CUDA
 */
function detectGpu({ binaryCuda = false } = {}) {
  const info = probeNvidiaSmi() || probeWmi() ||
    { vendor: 'none', model: 'none', cuda: false, compute: null, vramMb: null, driver: null };

  info.binaryCuda = !!binaryCuda;
  info.accelerated = !!(info.cuda && binaryCuda);

  if (info.cuda && !binaryCuda) {
    info.reason = 'CUDA GPU present, but the whisper sidecar was built CPU-only.';
  } else if (!info.cuda) {
    info.reason = 'No CUDA GPU detected - transcription will run on the CPU (slower).';
  } else if (String(info.compute) === '12.0') {
    info.reason = 'GPU acceleration available (Blackwell sm_120 via whisper.cpp CUDA arch 120).';
  } else {
    info.reason = 'GPU acceleration available.';
  }
  return info;
}

module.exports = { detectGpu };
