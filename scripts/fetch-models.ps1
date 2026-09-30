# scripts/fetch-models.ps1
# Download ggml Whisper models into native/models.
# Default: small.en (bundled default). Optional: large-v3-turbo (multilingual).
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/fetch-models.ps1 [-All]

param(
    [switch]$All
)

$ErrorActionPreference = "Stop"
$root    = Split-Path -Parent $PSScriptRoot
$mdlDir  = Join-Path $root "native\models"
New-Item -ItemType Directory -Force -Path $mdlDir | Out-Null

$base = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

# id -> filename  (sizes from the ggml model card; see docs/PLAN.md §3)
$default = @{ id = "small.en"; file = "ggml-small.en.bin" }        # 466 MiB — standard English

$optional = @(
    @{ id = "large-v3-turbo"; file = "ggml-large-v3-turbo.bin" }   # 1.5 GiB — multilingual, best quality-per-VRAM
    @{ id = "base.en";        file = "ggml-base.en.bin" }          # 142 MiB — fast fallback
    @{ id = "tiny.en";        file = "ggml-tiny.en.bin" }          #  75 MiB — ultra fast
)

function Get-Model($id, $file) {
    $dest = Join-Path $mdlDir $file
    if (Test-Path $dest) { Write-Host "have  $file" -ForegroundColor DarkGray; return }

    Write-Host "fetch $file ..." -ForegroundColor Cyan
    $url = "$base/$file"
    # curl.exe ships with Windows 10+; -L follows redirects, -C - resumes
    & curl.exe -L -C - --fail --output $dest $url
    if ($LASTEXITCODE -ne 0) {
        Remove-Item $dest -ErrorAction SilentlyContinue
        throw "download failed: $url"
    }
    $mb = [math]::Round((Get-Item $dest).Length / 1MB, 1)
    Write-Host "  -> $file ($mb MiB)" -ForegroundColor Green
}

Get-Model $default.id $default.file

if ($All) {
    foreach ($m in $optional) { Get-Model $m.id $m.file }
} else {
    Write-Host "`nSkipped optional models. Run with -All to fetch:" -ForegroundColor Yellow
    foreach ($m in $optional) { Write-Host "  - $($m.id)  ($($m.file))" }
}

Write-Host "`nModels in native\models:" -ForegroundColor Cyan
Get-ChildItem $mdlDir -Filter "*.bin" | ForEach-Object {
    "{0,-32} {1,8:N1} MiB" -f $_.Name, ($_.Length / 1MB)
}
