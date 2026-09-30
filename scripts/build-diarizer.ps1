# scripts/build-diarizer.ps1
# Build NVIDIA NeMo-Speech.cpp (pinned) for speaker diarization and install it app-locally.
# Output: native/bin/diarizer/ (nemo-speech.exe + its own ggml DLLs + VC++ runtime DLLs)
#         native/models/Nemotron-3-Diarization.q8_0.gguf (SHA-256 checked)
#
# Why its own folder: nemo-speech ships ggml*.dll with the same names as whisper.cpp's but from
# a different ggml revision; Windows loads DLLs from the exe's folder first, so a subfolder keeps
# both engines intact. The VC++ runtime is copied next to the exe so the portable app does not
# depend on the redistributable being installed.
#
# Why a source build: Nemotron-3-Diarization support landed on main (97a15af) after the v0.1.0
# release; the v0.1.0 prebuilt rejects the model ("pre_ln transformer variant is not supported").
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/build-diarizer.ps1
#   ... -BuildDir C:\tmp\ns\build-cpu-asr   # reuse an existing build, skip clone/build
#   ... -ModelFile D:\dl\Nemotron-3-Diarization.q8_0.gguf   # use a local copy of the model
#
# The source tree must live on a SHORT path: llama.cpp (a submodule) has paths beyond MAX_PATH.

param(
    [string]$SrcDir = (Join-Path $env:TEMP 'ns'),
    [string]$BuildDir,
    [string]$ModelFile,
    [ValidateSet('cpu', 'cuda')] [string]$Backend = 'cpu'
)

$ErrorActionPreference = 'Stop'
$root      = Split-Path -Parent $PSScriptRoot
$outDir    = Join-Path $root 'native\bin\diarizer'
$modelDir  = Join-Path $root 'native\models'

$Repo       = 'https://github.com/NVIDIA/NeMo-Speech.cpp.git'
$Commit     = '97a15af'   # feat(diar): make Nemotron 3 Diarization the default diarizer (#52)
$ModelName  = 'Nemotron-3-Diarization.q8_0.gguf'
$ModelUrl   = "https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/main/$ModelName"
$ModelSha   = '08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1'

# ---- 1. build (unless an existing build dir was given) ----
if (-not $BuildDir) {
    if (-not (Test-Path (Join-Path $SrcDir '.git'))) {
        Write-Host "Cloning NeMo-Speech.cpp into $SrcDir ..." -ForegroundColor Cyan
        git clone --filter=blob:none $Repo $SrcDir
        if ($LASTEXITCODE -ne 0) { throw 'clone failed' }
    }
    git -C $SrcDir fetch --quiet origin
    git -C $SrcDir checkout --quiet $Commit
    if ($LASTEXITCODE -ne 0) { throw "checkout $Commit failed" }

    # Upstream hard-codes 4 CPU compute threads; the patch lets NEMO_SPEECH_CPU_THREADS raise it
    # (default unchanged). ~2.4x faster at 16 threads with byte-identical output.
    $patch = Join-Path $PSScriptRoot 'patches\nemo-speech-cpu-threads.patch'
    git -C $SrcDir apply --reverse --check $patch 2>$null
    if ($LASTEXITCODE -ne 0) {
        git -C $SrcDir apply $patch
        if ($LASTEXITCODE -ne 0) { throw "could not apply $patch" }
        Write-Host 'Applied nemo-speech-cpu-threads.patch' -ForegroundColor Green
    }

    # cmd.exe (vcvars64.bat) silently truncates a PATH over 8191 chars and loses git/cmake;
    # build.ps1 re-adds the machine + user PATH from the registry, so start the child minimal.
    $minimal = @(
        "$env:SystemRoot\System32", $env:SystemRoot, "$env:SystemRoot\System32\WindowsPowerShell\v1.0",
        (Split-Path (Get-Command git).Source), (Split-Path (Get-Command cmake).Source),
        (Split-Path (Get-Command ninja).Source)
    ) -join ';'
    $saved = $env:Path
    try {
        $env:Path = $minimal
        $env:GIT_CONFIG_COUNT = '1'; $env:GIT_CONFIG_KEY_0 = 'core.longpaths'; $env:GIT_CONFIG_VALUE_0 = 'true'
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $SrcDir 'scripts\windows\build.ps1') -Backend $Backend -Profile asr
        if ($LASTEXITCODE -ne 0) { throw "NeMo-Speech.cpp build failed ($LASTEXITCODE)" }
    } finally {
        $env:Path = $saved
        Remove-Item Env:GIT_CONFIG_COUNT, Env:GIT_CONFIG_KEY_0, Env:GIT_CONFIG_VALUE_0 -ErrorAction SilentlyContinue
    }
    $BuildDir = Join-Path $SrcDir "build-$Backend-asr"
}
$builtBin = Join-Path $BuildDir 'bin'
if (-not (Test-Path (Join-Path $builtBin 'nemo-speech.exe'))) { throw "nemo-speech.exe not found in $builtBin" }

# ---- 2. install exe + DLLs into their own folder ----
if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item (Join-Path $builtBin '*.exe'), (Join-Path $builtBin '*.dll') $outDir
Write-Host "Installed $(Get-ChildItem $outDir | Measure-Object | Select-Object -ExpandProperty Count) files -> native\bin\diarizer" -ForegroundColor Green

# ---- 3. app-local VC++ runtime (msvcp140, vcruntime140[_1], vcomp140 for ggml's OpenMP) ----
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$redist = Get-ChildItem (Join-Path $vs 'VC\Redist\MSVC') -Directory | Where-Object { $_.Name -match '^\d' } |
          Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $redist) { throw 'VC++ redist folder not found in the Visual Studio install' }
$crt = Get-ChildItem (Join-Path $redist.FullName 'x64') -Directory -Filter 'Microsoft.VC*.CRT' | Select-Object -First 1
$omp = Get-ChildItem (Join-Path $redist.FullName 'x64') -Directory -Filter 'Microsoft.VC*.OpenMP' | Select-Object -First 1
foreach ($dll in 'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll') { Copy-Item (Join-Path $crt.FullName $dll) $outDir }
Copy-Item (Join-Path $omp.FullName 'vcomp140.dll') $outDir
Write-Host "Copied VC++ runtime from $($redist.Name)" -ForegroundColor Green

# ---- 4. model (SHA-256 checked) ----
New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
$dest = Join-Path $modelDir $ModelName
if ($ModelFile) { Copy-Item $ModelFile $dest -Force }
elseif (-not (Test-Path $dest)) {
    Write-Host "Downloading $ModelName (~102 MiB) ..." -ForegroundColor Cyan
    curl.exe -sSfL -o $dest $ModelUrl
    if ($LASTEXITCODE -ne 0) { throw 'model download failed' }
}
$sha = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
if ($sha -ne $ModelSha) { Remove-Item $dest; throw "model SHA-256 mismatch: $sha" }
Write-Host "Model OK: $dest" -ForegroundColor Green

# ---- 5. smoke ----
$ver = & (Join-Path $outDir 'nemo-speech.exe') --version
$info = & (Join-Path $outDir 'nemo-speech.exe') --json model info $dest | ConvertFrom-Json
if (-not $info.runtime_compatible) { throw "runtime rejects the model: $($info.errors -join '; ')" }
Write-Host "$ver + $ModelName ($($info.architecture)) ready." -ForegroundColor Green
