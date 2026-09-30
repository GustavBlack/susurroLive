# Provision the Parakeet (sherpa-onnx) ASR engine for development.
#
# Downloads, pinned:
#   - sherpa-onnx win-x64 prebuilt (sherpa-onnx-offline.exe + onnxruntime DLLs)
#   - sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 model (~465 MB)
#
# Layout produced (both gitignored under native/):
#   native/bin/sherpa/sherpa-onnx-offline.exe + DLLs
#   native/models/sherpa/encoder.int8.onnx, decoder.int8.onnx, joiner.int8.onnx, tokens.txt
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts/fetch-parakeet.ps1
# Not bundled in releases by default (portable NSIS ~2 GB ceiling) - see docs/adr/0006.

$ErrorActionPreference = 'Stop'

$SHERPA_VERSION = '1.13.8'
$SHERPA_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$SHERPA_VERSION/sherpa-onnx-v$SHERPA_VERSION-win-x64-shared-MT-Release-no-tts.tar.bz2"
$MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2'

$repo = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $repo 'native\bin\sherpa'
$modelDir = Join-Path $repo 'native\models\sherpa'
$tmp = Join-Path $env:TEMP 'susurro-parakeet'
New-Item -ItemType Directory -Force -Path $binDir, $modelDir, $tmp | Out-Null

function Fetch($url, $dest) {
  if (Test-Path $dest) { Write-Host "cached: $dest"; return }
  Write-Host "downloading $url"
  # curl is preinstalled on Windows 10/11 and handles the GitHub redirect chain
  & curl.exe -L --fail --retry 3 -o $dest $url
  if ($LASTEXITCODE -ne 0) { throw "download failed: $url" }
}

# --- engine binaries ----------------------------------------------------------
$exe = Join-Path $binDir 'sherpa-onnx-offline.exe'
if (-not (Test-Path $exe)) {
  $tb = Join-Path $tmp "sherpa-$SHERPA_VERSION.tar.bz2"
  Fetch $SHERPA_URL $tb
  Write-Host 'extracting engine...'
  $stage = Join-Path $tmp 'sherpa-stage'
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  # bsdtar (preinstalled on Windows) reads .tar.bz2 directly
  & tar -xjf $tb -C $stage
  if ($LASTEXITCODE -ne 0) { throw "extract failed: $tb" }
  $root = Get-ChildItem $stage | Select-Object -First 1
  # exe + every DLL it needs (onnxruntime + runtime deps)
  Copy-Item (Join-Path $root 'sherpa-onnx-offline.exe') $binDir -Force
  Get-ChildItem $root -Filter '*.dll' | Copy-Item -Destination $binDir -Force
  Remove-Item -Recurse -Force $stage
} else {
  Write-Host 'engine already provisioned'
}

# --- model ---------------------------------------------------------------------
$marker = Join-Path $modelDir 'tokens.txt'
if (-not (Test-Path $marker)) {
  $mb = Join-Path $tmp 'parakeet-v3-int8.tar.bz2'
  Fetch $MODEL_URL $mb
  Write-Host 'extracting model (~465 MB compressed)...'
  $stage = Join-Path $tmp 'parakeet-stage'
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  & tar -xjf $mb -C $stage
  if ($LASTEXITCODE -ne 0) { throw "extract failed: $mb" }
  $root = Get-ChildItem $stage | Select-Object -First 1
  Copy-Item (Join-Path $root '*') $modelDir -Force
  Remove-Item -Recurse -Force $stage
} else {
  Write-Host 'model already provisioned'
}

# --- verify ---------------------------------------------------------------------
$needed = 'sherpa-onnx-offline.exe', 'encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'
$missing = @()
if (-not (Test-Path $exe)) { $missing += $exe }
foreach ($f in 'encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt') {
  if (-not (Test-Path (Join-Path $modelDir $f))) { $missing += $f }
}
if ($missing.Count -gt 0) { throw "missing after install: $($missing -join ', ')" }

Write-Host ''
Write-Host 'parakeet provisioned:'
Write-Host "  engine: $binDir"
Write-Host "  model : $modelDir"
Write-Host 'verify with: node tools/test-parakeet-engine.js'
