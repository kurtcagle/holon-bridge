#Requires -Version 5.1
<#
.SYNOPSIS
    Start-HolonBridge.ps1 -- Launch the full HolonBridge stack in dev mode.

.DESCRIPTION
    Starts five services in sequence, each in its own PowerShell window:
      1. Apache Jena Fuseki          (:3030)
      2. ngrok tunnel — HolonBridge  (:3031)
      3. HolonBridge REST API        (:3031)
      4. ngrok tunnel — MCP remote   (:3032)
      5. HolonBridge MCP remote      (:3032)

    Polls each service before starting the next so you get a clean ordered
    startup rather than a race.  Default paths and URLs come from
    holonbridge.config.ps1 in the same directory; command-line parameters
    override those values.

    ngrok is only required when running locally without a public-facing web
    server.  If your server is publicly accessible, set $NgrokUrl /
    $McpNgrokUrl to your own domain names and use -SkipNgrok.

.PARAMETER Dataset
    Initial Fuseki dataset to activate. Default: ds

.PARAMETER JenaDir
    Path to the Jena Fuseki installation directory.

.PARAMETER JenaData
    Path to the Fuseki persistent databases directory.

.PARAMETER BridgeDir
    Path to the holon-bridge repository root.

.PARAMETER McpDir
    Path to the mcp-remote directory. Default: <BridgeDir>\mcp-remote

.PARAMETER NgrokUrl
    Reserved ngrok subdomain for HolonBridge REST (:3031).
    Set to your own domain if not using ngrok.

.PARAMETER McpNgrokUrl
    Reserved ngrok subdomain for the MCP remote (:3032).
    Set to your own domain if not using ngrok.

.PARAMETER SkipNgrok
    Skip both ngrok tunnel steps (use when hosting on a public server).

.PARAMETER LogDir
    Directory for log files.

.EXAMPLE
    .\Start-HolonBridge.ps1
    .\Start-HolonBridge.ps1 -Dataset chloe
    .\Start-HolonBridge.ps1 -SkipNgrok   # public server, no ngrok needed
#>

[CmdletBinding()]
param(
    [string] $Dataset      = '',
    [string] $JenaDir      = '',
    [string] $JenaData     = '',
    [string] $BridgeDir    = '',
    [string] $McpDir       = '',
    [string] $NgrokUrl     = '',
    [string] $McpNgrokUrl  = '',
    [switch] $SkipNgrok,
    [string] $LogDir       = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Load config file, then let explicit params override ──────────────────────

$cfg = Join-Path $PSScriptRoot 'holonbridge.config.ps1'
if (Test-Path $cfg) { . $cfg }

if (-not $Dataset)     { $Dataset     = if ($Dataset)     { $Dataset }     else { 'ds' } }
if (-not $JenaDir)     { $JenaDir     = if ($JenaDir)     { $JenaDir }     else { 'C:\apache\apache-jena-fuseki-6.1.0' } }
if (-not $JenaData)    { $JenaData    = if ($JenaData)    { $JenaData }    else { 'C:\ProgramData\HolonBridge\databases' } }
if (-not $BridgeDir)   { $BridgeDir   = if ($BridgeDir)   { $BridgeDir }   else { 'C:\ProgramData\HolonBridge' } }
if (-not $McpDir)      { $McpDir      = if ($McpDir)      { $McpDir }      else { "$BridgeDir\mcp-remote" } }
if (-not $NgrokUrl)    { $NgrokUrl    = if ($NgrokUrl)    { $NgrokUrl }    else { 'yourServer.ngrok.io' } }
if (-not $McpNgrokUrl) { $McpNgrokUrl = if ($McpNgrokUrl) { $McpNgrokUrl } else { 'yourServer-mcp.ngrok.io' } }
if (-not $LogDir)      { $LogDir      = "$BridgeDir\logs" }

# ── Helpers ───────────────────────────────────────────────────────────────────

function Write-Step ([string]$msg) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $msg" -ForegroundColor Cyan
}
function Write-Ok ([string]$msg) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] OK  $msg" -ForegroundColor Green
}
function Write-Fail ([string]$msg) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] ERR $msg" -ForegroundColor Red
}

function Wait-Http ([string]$url, [int]$timeoutSec = 30, [string]$label = $url) {
    Write-Step "Waiting for $label ..."
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($r.StatusCode -lt 400) { Write-Ok "$label is ready."; return $true }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    Write-Fail "$label did not respond within ${timeoutSec}s."
    return $false
}

function Start-Window ([string]$title, [string]$command) {
    Start-Process powershell -ArgumentList `
        "-NoExit", "-Command", `
        "Write-Host '$title' -ForegroundColor Yellow; $command" `
        -WindowStyle Normal
}

# ── Validate prerequisites ────────────────────────────────────────────────────

$fusekiBin = Join-Path $JenaDir 'bin\fuseki-server.bat'
if (-not (Test-Path $fusekiBin)) {
    Write-Fail "Fuseki not found at: $fusekiBin"
    Write-Fail "Set JenaDir in holonbridge.config.ps1 or pass -JenaDir."
    exit 1
}
if (-not (Test-Path $BridgeDir)) {
    Write-Fail "BridgeDir not found: $BridgeDir"
    exit 1
}
if (-not (Test-Path "$BridgeDir\server.js")) {
    Write-Fail "server.js not found in $BridgeDir -- is this the holon-bridge repo root?"
    exit 1
}
if (-not (Test-Path $McpDir)) {
    Write-Fail "MCP remote directory not found: $McpDir"
    Write-Fail "Expected: $BridgeDir\mcp-remote"
    exit 1
}
if (-not (Test-Path "$McpDir\holonbridge-mcp-remote.js")) {
    Write-Fail "holonbridge-mcp-remote.js not found in: $McpDir"
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Fail "node not found in PATH. Install Node.js >= 18."
    exit 1
}
if (-not $SkipNgrok -and -not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
    Write-Fail "ngrok not found in PATH. Install from https://ngrok.com or run with -SkipNgrok."
    exit 1
}

foreach ($dir in @($LogDir, $JenaData)) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

# ── 1. Jena Fuseki ────────────────────────────────────────────────────────────

Write-Step "Starting Jena Fuseki..."
Start-Window "Jena Fuseki :3030" "& '$fusekiBin' --update --loc '$JenaData'"

if (-not (Wait-Http 'http://localhost:3030/$/ping' 30 'Jena Fuseki :3030')) {
    Write-Fail "Fuseki failed to start. Check the Fuseki window."; exit 1
}

# ── 2. ngrok — HolonBridge REST :3031 ────────────────────────────────────────

if (-not $SkipNgrok) {
    Write-Step "Starting ngrok tunnel for HolonBridge REST (:3031 → $NgrokUrl)..."
    Start-Window "ngrok :3031" "ngrok http --url=$NgrokUrl 3031"
    if (-not (Wait-Http 'http://localhost:4040/api/tunnels' 20 'ngrok :3031')) {
        Write-Fail "ngrok tunnel for :3031 did not start."; exit 1
    }
    Write-Ok "Tunnel up: https://$NgrokUrl"
}

# ── 3. HolonBridge REST ───────────────────────────────────────────────────────

Write-Step "Starting HolonBridge REST..."
Start-Window "HolonBridge REST :3031" "cd '$BridgeDir'; node server.js"

if (-not (Wait-Http 'http://localhost:3031/health' 20 'HolonBridge REST :3031')) {
    Write-Fail "HolonBridge REST failed to start. Check the HolonBridge window."; exit 1
}

# ── 4. ngrok — MCP remote :3032 ───────────────────────────────────────────────

if (-not $SkipNgrok) {
    Write-Step "Starting ngrok tunnel for MCP remote (:3032 → $McpNgrokUrl)..."
    Start-Window "ngrok :3032" "ngrok http --url=$McpNgrokUrl 3032"
    # Poll ngrok's local API for the second tunnel
    $deadline = (Get-Date).AddSeconds(20)
    $mcpTunnelUp = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $tunnels = (Invoke-WebRequest -Uri 'http://localhost:4040/api/tunnels' -UseBasicParsing -TimeoutSec 2).Content |
                       ConvertFrom-Json
            if ($tunnels.tunnels.Count -ge 2) { $mcpTunnelUp = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if ($mcpTunnelUp) { Write-Ok "Tunnel up: https://$McpNgrokUrl" }
    else { Write-Fail "ngrok tunnel for :3032 may not have started. Check the ngrok window." }
}

# ── 5. MCP remote ─────────────────────────────────────────────────────────────

Write-Step "Starting HolonBridge MCP remote..."
Start-Window "HolonBridge MCP remote :3032" "cd '$McpDir'; node holonbridge-mcp-remote.js"

if (-not (Wait-Http 'http://localhost:3032/health' 20 'MCP remote :3032')) {
    Write-Fail "MCP remote failed to start. Check the MCP remote window."
} else {
    Write-Host ""
    Write-Ok "All services running."
    Write-Host ""
    Write-Host "  Jena Fuseki   : http://localhost:3030"          -ForegroundColor White
    Write-Host "  HolonBridge   : http://localhost:3031/health"   -ForegroundColor White
    Write-Host "  MCP remote    : http://localhost:3032/health"   -ForegroundColor White
    if (-not $SkipNgrok) {
        Write-Host "  Bridge tunnel : https://$NgrokUrl"          -ForegroundColor White
        Write-Host "  MCP tunnel    : https://$McpNgrokUrl"       -ForegroundColor White
    }
    Write-Host ""
    Write-Host "  Add to claude.ai:" -ForegroundColor DarkGray
    if ($SkipNgrok) {
        Write-Host "    URL: https://<your-mcp-domain>/sse" -ForegroundColor DarkGray
    } else {
        Write-Host "    URL: https://$McpNgrokUrl/sse" -ForegroundColor DarkGray
    }
    Write-Host "    Auth: Authorization: Bearer <MCP_REMOTE_TOKEN>" -ForegroundColor DarkGray
    Write-Host ""
}
