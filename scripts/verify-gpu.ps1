# scripts/verify-gpu.ps1
# Probe GPU + CUDA capability and emit the GpuInfo shape the app expects.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/verify-gpu.ps1

$ErrorActionPreference = "SilentlyContinue"

$info = [ordered]@{
    vendor  = "none"
    model   = "none"
    cuda    = $false
    compute = $null
    vramMb  = $null
    driver  = $null
}

# ---- NVIDIA (authoritative) ----
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) {
    $q = & nvidia-smi --query-gpu=name,compute_cap,memory.total,driver_version --format=csv,noheader 2>$null
    if ($LASTEXITCODE -eq 0 -and $q) {
        $parts = ($q | Select-Object -First 1) -split ",\s*"
        $info.vendor  = "NVIDIA"
        $info.model   = $parts[0]
        $info.compute = $parts[1]
        $info.vramMb  = ($parts[2] -replace "[^\d]", "")
        $info.driver  = $parts[3]
        $info.cuda    = $true
    }
} else {
    # ---- non-NVIDIA fallback: report the display adapter ----
    $vga = Get-CimInstance Win32_VideoController | Select-Object -First 1
    if ($vga) {
        $info.vendor = if ($vga.Name -match "AMD|Radeon") { "AMD" }
                       elseif ($vga.Name -match "Intel") { "Intel" }
                       else { "unknown" }
        $info.model  = $vga.Name
        $info.cuda   = $false
    }
}

# ---- Blackwell sanity note ----
if ($info.compute -eq "12.0") {
    Write-Host "Blackwell (sm_120) detected -> whisper.cpp MUST be built with -DCMAKE_CUDA_ARCHITECTURES incl. 120." -ForegroundColor Yellow
}

$json = $info | ConvertTo-Json -Compress
Write-Host $json

if ($info.cuda) {
    Write-Host "`nGPU acceleration AVAILABLE. The app will transcribe on GPU." -ForegroundColor Green
} else {
    Write-Host "`nNo CUDA GPU. The app will transcribe on CPU (slower) and warn the user." -ForegroundColor Yellow
}
