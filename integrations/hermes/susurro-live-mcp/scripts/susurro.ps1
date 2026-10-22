#requires -Version 5.1
<#
  susurro.ps1 - Hermes skill helper for susurroLive's local MCP endpoint.

  The app owns the state; this script only reads %APPDATA%\susurroLive\mcp.json,
  launches the app when needed, and speaks MCP JSON-RPC over loopback HTTP.
  It never prints the bearer token.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Command,

  [Alias('Profile')]
  [string]$ProfileName = 'meeting',

  [string]$Parent,
  [string]$Name,
  [int]$ChunkSec = 0,
  [string]$Engine,
  [string]$Model,
  [string]$Language,
  [string]$Device,
  [switch]$ForceNew,

  [string]$Folder,
  [ValidateSet('text', 'json')]
  [string]$Format = 'text',
  [switch]$Corrected,

  [ValidateSet('txt', 'json', 'audio')]
  [string]$Kind = 'txt',
  [string]$MediaPath,

  [int]$TimeoutSec = 120,
  [switch]$Wait,
  [switch]$Json,

  [string]$Tool,
  [string]$ArgsJson = '{}',

  [string]$AppPath,
  [string]$SessionsDir,

  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:Initialized = $false

function Get-DiscoveryPath {
  if ($env:SUSURRO_MCP_DISCOVERY) { return $env:SUSURRO_MCP_DISCOVERY }
  $candidates = @(
    (Join-Path $env:APPDATA 'susurroLive\mcp.json'),
    (Join-Path $env:APPDATA 'susurro-live\mcp.json'),
    (Join-Path $env:LOCALAPPDATA 'susurroLive\mcp.json')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  throw 'susurroLive MCP discovery was not found. Start the app, then enable Settings > Agents (MCP).'
}

function Read-Discovery {
  $path = Get-DiscoveryPath
  $doc = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if (-not $doc.token) { throw "MCP discovery at $path has no token. Start susurroLive once with Agents (MCP) enabled." }
  if (-not $doc.url) { throw 'susurroLive MCP is not listening. Enable Settings > Agents (MCP) or check the port.' }
  $uri = [Uri][string]$doc.url
  if ($uri.Scheme -ne 'http' -or @('127.0.0.1', 'localhost') -notcontains $uri.Host) {
    throw "Refusing a non-loopback MCP URL ($($uri.Scheme)://$($uri.Host)). The token is only sent to 127.0.0.1/localhost."
  }
  return @{ Path = $path; Url = [string]$doc.url; Token = [string]$doc.token }
}

function Invoke-McpRaw {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [hashtable]$Params = @{},
    [switch]$Notification
  )
  $d = Read-Discovery
  $headers = @{
    Authorization = "Bearer $($d.Token)"
    Accept = 'application/json, text/event-stream'
    'MCP-Protocol-Version' = '2025-11-25'
  }
  if ($Notification) {
    $payload = @{ jsonrpc = '2.0'; method = $Method; params = $Params }
  } else {
    $payload = @{ jsonrpc = '2.0'; id = 1; method = $Method; params = $Params }
  }
  $body = $payload | ConvertTo-Json -Depth 20 -Compress
  try {
    return Invoke-RestMethod -Uri $d.Url -Method Post -Headers $headers `
      -ContentType 'application/json' -Body $body -TimeoutSec $TimeoutSec
  } catch {
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -eq 401) {
      throw 'susurroLive rejected the MCP token (401). The token may have been rotated: re-read %APPDATA%\susurroLive\mcp.json or copy the new Hermes config from Settings.'
    }
    throw "Could not reach susurroLive MCP at $($d.Url): $($_.Exception.Message)"
  }
}

function Initialize-Mcp {
  if ($script:Initialized) { return }
  $init = Invoke-McpRaw -Method 'initialize' -Params @{
    protocolVersion = '2025-11-25'
    capabilities = @{}
    clientInfo = @{ name = 'susurro-skill'; version = '0.1.0' }
  }
  if ($init.error) { throw "MCP initialize failed: $($init.error.message)" }
  Invoke-McpRaw -Method 'notifications/initialized' -Params @{} -Notification | Out-Null
  $script:Initialized = $true
}

function Invoke-Tool {
  param([Parameter(Mandatory = $true)][string]$Name, [object]$Arguments = @{})
  Initialize-Mcp
  $resp = Invoke-McpRaw -Method 'tools/call' -Params @{ name = $Name; arguments = $Arguments }
  if ($resp.error) { throw "MCP error ($($resp.error.code)): $($resp.error.message)" }
  if ($resp.result.isError) {
    $text = ''
    if ($resp.result.content -and $resp.result.content.Count -gt 0) { $text = [string]$resp.result.content[0].text }
    throw "susurroLive tool $Name failed: $text"
  }
  $text = [string]$resp.result.content[0].text
  try { return ($text | ConvertFrom-Json) } catch { return $text }
}

function Resolve-AppPath {
  if ($AppPath) { return [Environment]::ExpandEnvironmentVariables($AppPath) }
  if ($env:SUSURRO_APP_PATH) { return [Environment]::ExpandEnvironmentVariables($env:SUSURRO_APP_PATH) }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\susurroLive\susurroLive.exe'),
    (Join-Path $env:ProgramFiles 'susurroLive\susurroLive.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'susurroLive\susurroLive.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

function Test-SusurroStatus {
  try {
    return (Invoke-Tool -Name 'app_status' -Arguments @{})
  } catch {
    $message = [string]$_.Exception.Message
    # Auth/rotation errors must surface immediately; do not launch a second app.
    if ($message -match '401|token') { throw }
    return $null
  }
}

function Get-SusurroProcesses {
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -match '^susurro' -or ($_.Path -and $_.Path -match 'susurroLive')
  })
}

function Ensure-App {
  $status = Test-SusurroStatus
  if ($status -and $status.rendererReady) { return $status }

  $running = Get-SusurroProcesses
  if ($running.Count -gt 0) {
    throw 'susurroLive is running but its MCP endpoint is not reachable. Enable Settings > Agents (MCP) and check that port 8790 is free.'
  }

  $exe = Resolve-AppPath
  if (-not $exe -or -not (Test-Path -LiteralPath $exe)) {
    throw 'susurroLive.exe was not found. Set skills.config.susurro.app_path, set SUSURRO_APP_PATH, or pass -AppPath.'
  }

  Start-Process -FilePath $exe | Out-Null
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $status = Test-SusurroStatus
    if ($status -and $status.rendererReady) { return $status }
  }
  throw 'susurroLive started but its MCP endpoint did not become ready within 30 seconds. Check Settings > Agents (MCP).'
}

function Get-Parent {
  if ($Parent) { return [IO.Path]::GetFullPath($Parent) }
  if ($SessionsDir) { return [IO.Path]::GetFullPath($SessionsDir) }
  return $null
}

function Write-JsonOrHuman {
  param($Value, [string]$Human)
  if ($Json) { $Value | ConvertTo-Json -Depth 20 } else { Write-Output $Human }
}

function Format-Sources {
  param($Sources)
  if (-not $Sources) { return 'none' }
  return (($Sources | ForEach-Object { "$($_.kind):$($_.label)" }) -join ', ')
}

function Show-Status {
  param($Status)
  $rec = $Status.recording
  $sess = $Status.session
  $text = @(
    "susurroLive $($Status.appVersion) | renderer ready: $($Status.rendererReady)"
    "MCP: $($Status.mcp.url) | listening: $($Status.mcp.running)"
    "sessions root: $($Status.sessionsRoot)"
    "session: $(if ($sess) { $sess.name + ' - ' + $sess.folder } else { 'none' })"
    "recording: $(if ($rec.active) { if ($rec.paused) { 'paused' } else { 'recording' } } else { 'idle' }) | $([math]::Round($rec.durationSec, 1)) s | sources: $(Format-Sources $rec.sources)"
    "transcription: remaining $($Status.transcription.remaining), running $($Status.transcription.running), complete: $($Status.transcription.complete)"
  ) -join [Environment]::NewLine
  Write-JsonOrHuman -Value $Status -Human $text
}

function Show-Start {
  param($Started)
  $text = @(
    "Recording started - $($Started.name)"
    "folder: $($Started.sessionFolder)"
    "profile: $($Started.profile) | sources: $(Format-Sources $Started.sources)"
    "sample rate: $($Started.sampleRate) | chunk: $($Started.chunkSec) s"
  ) -join [Environment]::NewLine
  Write-JsonOrHuman -Value $Started -Human $text
}

function Show-Transcript {
  param($Transcript)
  if ($Format -eq 'text') {
    if ($Json) { $Transcript | ConvertTo-Json -Depth 20 } else { Write-Output $Transcript.text }
    return
  }
  Write-JsonOrHuman -Value $Transcript -Human ($Transcript | ConvertTo-Json -Depth 20)
}

function Show-Tools {
  param($Tools)
  if ($Json) { $Tools | ConvertTo-Json -Depth 20; return }
  foreach ($tool in $Tools) { Write-Output ("{0,-24} {1}" -f $tool.name, $tool.description) }
}

try {
  switch ($Command.ToLowerInvariant()) {
    'ensure' {
      $status = Ensure-App
      Show-Status -Status $status
    }
    'status' {
      $status = Ensure-App
      Show-Status -Status $status
    }
    'sources' {
      Ensure-App | Out-Null
      $result = Invoke-Tool -Name 'sources_list' -Arguments @{}
      if ($Json) {
        $result | ConvertTo-Json -Depth 20
      } else {
        Write-Output 'microphones:'
        foreach ($mic in $result.microphones) { Write-Output ("  {0}  {1}" -f $mic.deviceId, $mic.label) }
        Write-Output 'loopback screens:'
        foreach ($screen in $result.loopbacks) { Write-Output ("  {0}  {1}" -f $screen.id, $screen.label) }
      }
    }
    'sessions' {
      Ensure-App | Out-Null
      $arguments = @{}
      $parent = Get-Parent
      if ($parent) { $arguments.parentDir = $parent }
      $result = Invoke-Tool -Name 'session_list' -Arguments $arguments
      if ($Json) {
        $result | ConvertTo-Json -Depth 20
      } else {
        foreach ($s in $result.sessions) {
          Write-Output ("{0}  {1}  {2} s  {3}/{4} chunks" -f $s.name, $s.folder, [math]::Round($s.durationSec, 1), $s.transcribed, $s.chunks)
        }
      }
    }
    'start' {
      Ensure-App | Out-Null
      $arguments = @{ profile = $ProfileName }
      $parent = Get-Parent
      if ($parent) { $arguments.parentDir = $parent }
      if ($Name) { $arguments.name = $Name }
      if ($ChunkSec -gt 0) { $arguments.chunkSec = $ChunkSec }
      if ($Engine) { $arguments.engine = $Engine }
      if ($Model) { $arguments.model = $Model }
      if ($Language) { $arguments.language = $Language }
      if ($Device) { $arguments.device = $Device }
      if ($ForceNew) { $arguments.newSession = $true }
      Show-Start -Started (Invoke-Tool -Name 'recording_start' -Arguments $arguments)
    }
    'pause' {
      Ensure-App | Out-Null
      $result = Invoke-Tool -Name 'recording_pause' -Arguments @{}
      Write-JsonOrHuman -Value $result -Human 'Recording paused.'
    }
    'resume' {
      Ensure-App | Out-Null
      $result = Invoke-Tool -Name 'recording_resume' -Arguments @{}
      Write-JsonOrHuman -Value $result -Human 'Recording resumed.'
    }
    'stop' {
      Ensure-App | Out-Null
      $arguments = @{ waitForTranscription = $Wait.IsPresent; timeoutMs = ($TimeoutSec * 1000) }
      $result = Invoke-Tool -Name 'recording_stop' -Arguments $arguments
      $human = "Stopped: $([math]::Round($result.durationSec, 1)) s, $($result.chunks) chunks; transcription complete: $($result.transcription.complete)."
      if ($result.sessionFolder) { $human += "`nFolder: $($result.sessionFolder)" }
      Write-JsonOrHuman -Value $result -Human $human
    }
    'wait' {
      Ensure-App | Out-Null
      $result = Invoke-Tool -Name 'transcription_wait' -Arguments @{ timeoutMs = ($TimeoutSec * 1000) }
      Write-JsonOrHuman -Value $result -Human "Transcription complete: $($result.transcription.complete)"
    }
    'transcript' {
      Ensure-App | Out-Null
      $arguments = @{ format = $Format }
      if ($Folder) { $arguments.sessionFolder = [IO.Path]::GetFullPath($Folder) }
      if ($Corrected) { $arguments.corrected = $true }
      $result = Invoke-Tool -Name 'transcript_get' -Arguments $arguments
      Show-Transcript -Transcript $result
    }
    'export' {
      Ensure-App | Out-Null
      $arguments = @{ kind = $Kind }
      if ($Folder) { $arguments.sessionFolder = [IO.Path]::GetFullPath($Folder) }
      $result = Invoke-Tool -Name 'export_run' -Arguments $arguments
      Write-JsonOrHuman -Value $result -Human "Exported $($result.kind) to $($result.path)"
    }
    'import' {
      if (-not $MediaPath) { throw 'import requires -MediaPath <file>' }
      Ensure-App | Out-Null
      $arguments = @{ mediaPath = [IO.Path]::GetFullPath($MediaPath) }
      $parent = Get-Parent
      if ($parent) { $arguments.parentDir = $parent }
      if ($Name) { $arguments.name = $Name }
      $result = Invoke-Tool -Name 'import_media' -Arguments $arguments
      Write-JsonOrHuman -Value $result -Human "Imported into $($result.session.folder) ($($result.chunks) chunks)"
    }
    'diarize' {
      Ensure-App | Out-Null
      $result = Invoke-Tool -Name 'diarize_run' -Arguments @{}
      Write-JsonOrHuman -Value $result -Human "Speakers identified: $($result.speakers)"
    }
    'tools' {
      Ensure-App | Out-Null
      Initialize-Mcp
      $resp = Invoke-McpRaw -Method 'tools/list' -Params @{}
      Show-Tools -Tools $resp.result.tools
    }
    'raw' {
      if (-not $Tool) { throw 'raw requires -Tool <name>' }
      Ensure-App | Out-Null
      $arguments = $ArgsJson | ConvertFrom-Json
      $result = Invoke-Tool -Name $Tool -Arguments $arguments
      $result | ConvertTo-Json -Depth 20
    }
    default {
      throw 'Commands: ensure, status, sources, sessions, start, pause, resume, stop, wait, transcript, export, import, diarize, tools, raw'
    }
  }
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
