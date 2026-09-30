# scripts/build-whisper.ps1
# Fetch + build whisper.cpp with CUDA + CPU, archs covering Pascal -> Blackwell (incl. RTX 5090).
# Output: native/bin/whisper-cli.exe (+ CUDA DLLs), native/whisper.cpp/ (source).
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/build-whisper.ps1 [-NoCuda]

param(
    [switch]$NoCuda
)

$ErrorActionPreference = "Stop"
$root      = Split-Path -Parent $PSScriptRoot
$srcDir    = Join-Path $root "native\whisper.cpp"
$binDir    = Join-Path $root "native\bin"

New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# ---- 1. fetch source ----
if (-not (Test-Path (Join-Path $srcDir ".git"))) {
    Write-Host "Cloning whisper.cpp..." -ForegroundColor Cyan
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git $srcDir
} else {
    Write-Host "Updating whisper.cpp..." -ForegroundColor Cyan
    git -C $srcDir pull --ff-only
}

# ---- 2. configure ----
# Robust CUDA detection for the build machine.
$hasNvcc = $false
try { $null = & nvcc --version 2>$null; $hasNvcc = ($LASTEXITCODE -eq 0) } catch {}

$cmakeArgs = @("-B", "build", "-DCMAKE_BUILD_TYPE=Release")
if (-not $NoCuda -and $hasNvcc) {
    Write-Host "nvcc found -> building WITH CUDA (archs 75;80;86;89;120)" -ForegroundColor Green
    # 75 Turing | 80,86 Ampere | 89 Ada | 120 Blackwell (RTX 50-series / 5090)
    $cmakeArgs += @("-DGGML_CUDA=1", "-DCMAKE_CUDA_ARCHITECTURES=75;80;86;89;120")
} else {
    Write-Host "No nvcc (or -NoCuda) -> CPU-only build" -ForegroundColor Yellow
    $cmakeArgs += @("-DGGML_CUDA=0")
}

Push-Location $srcDir
try {
    cmake @cmakeArgs
    if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }

    cmake --build build --config Release -j
    if ($LASTEXITCODE -ne 0) { throw "cmake build failed" }

    # ---- 3. copy artifacts ----
    $built = Get-ChildItem -Path (Join-Path $srcDir "build") -Recurse -Filter "whisper-cli*.exe" |
             Select-Object -First 1
    if (-not $built) { throw "whisper-cli.exe not found after build" }
    Copy-Item $built.FullName (Join-Path $binDir "whisper-cli.exe") -Force
    Write-Host "Copied whisper-cli.exe -> native\bin" -ForegroundColor Green
} finally {
    Pop-Location
}

# ---- 4. CUDA runtime DLLs (if building with CUDA) ----
if (-not $NoCuda -and $hasNvcc) {
    $cudaPath = $env:CUDA_PATH
    if ($cudaPath) {
        $dlls = @("cudart64_*.dll", "cublas64_*.dll", "cublasLt64_*.dll")
        foreach ($pat in $dlls) {
            Get-ChildItem -Path (Join-Path $cudaPath "bin") -Filter $pat -ErrorAction SilentlyContinue |
                ForEach-Object { Copy-Item $_.FullName $binDir -Force }
        }
        Write-Host "Copied CUDA runtime DLLs -> native\bin (verify cuDNN separately)" -ForegroundColor Green
        Write-Host "NOTE: cuDNN 9.x DLLs must also be present next to the sidecar for GPU inference." -ForegroundColor Yellow
    }
}

# ---- 5. smoke test ----
Write-Host "`nSmoke test:" -ForegroundColor Cyan
& (Join-Path $binDir "whisper-cli.exe") --help 2>&1 | Select-String -Pattern "usage|CUDA|error" | Select-Object -First 5
Write-Host "`nDone. Next: npm run native:models" -ForegroundColor Green
