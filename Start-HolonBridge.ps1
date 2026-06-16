#Requires -Version 5.1
<#
.SYNOPSIS
    Start-HolonBridge.ps1 -- Launch Jena Fuseki, ngrok, and HolonBridge.

.DESCRIPTION
    Starts all three HolonBridge services in sequence, each in its own
    PowerShell window.  Polls Fuseki's health endpoint before starting
    ngrok, and polls the ngrok tunnel before starting HolonBridge.

.PARAMETER Dataset
    Initial Fuseki dataset to activate in HolonBridge. Default: ds

.PARAMETER JenaDir
    Path to the Jena installation directory. Default: C:\jena

.PARAMETER JenaData
    Path to the Fuseki databases directory. Default: C:\ProgramData\HolonBridge\databases

.PARAMETER BridgeDir
    Path to the HolonBridge project directory.
    Default: C:\ProgramData\HolonBridge\chloe\projects\holonbridge

.PARAMETER NgrokUrl
    The reserved ngrok subdomain URL. Default: kurtcagle.ngrok.io

.PARAMETER LogDir
    Directory for log files. Default: C:\ProgramData\HolonBridge\logs

.EXAMPLE
    .\Start-HolonBridge.ps1
    .\Start-HolonBridge.ps1 -Dataset ggsc
    .\Start-HolonBridge.ps1 -JenaDir D:\tools\jena -Dataset ds
#>

[CmdletBinding()]
param(
    [string] $Dataset   = 'ds',
    [string] $JenaDir   = 'C:\jena',
    [string] $JenaData  = 'C:\ProgramData\HolonBridge\databases',
    [string] $BridgeDir = 'C:\ProgramData\HolonBridge',
    [string] $NgrokUrl  = 'kurtcagle.ngrok.io',
    [string] $LogDir    = 'C:\ProgramData\HolonBridge\logs'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

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
            if ($r.StatusCode -lt 400) {
                Write-Ok "$label is ready."
                return $true
            }
        } catch { <# not ready yet #> }
        Start-Sleep -Milliseconds 500
    }
    Write-Fail "$label did not respond within ${timeoutSec}s."
    return $false
}

# ---------------------------------------------------------------------------
# Validate paths
# ---------------------------------------------------------------------------

$fusekiBin = Join-Path $JenaDir 'bin\fuseki-server.bat'
if (-not (Test-Path $fusekiBin)) {
    $fusekiBin = Join-Path $JenaDir 'fuseki-server'   # Linux-style fallback
}
if (-not (Test-Path $fusekiBin)) {
    Write-Fail "Fuseki not found at $JenaDir. Set -JenaDir to your Jena installation."
    exit 1
}

if (-not (Test-Path $BridgeDir)) {
    Write-Fail "HolonBridge directory not found: $BridgeDir"
    exit 1
}

if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
    Write-Fail "ngrok not found in PATH. Install via: winget install ngrok.ngrok"
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Fail "node not found in PATH. Install Node.js >= 18."
    exit 1
}

# Ensure log and database directories exist
foreach ($dir in @($LogDir, $JenaData)) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-Step "Created directory: $dir"
    }
}

# ---------------------------------------------------------------------------
# 1. Start Jena Fuseki
# ---------------------------------------------------------------------------

Write-Step "Starting Jena Fuseki..."
$jenaArgs = "--update --loc `"$JenaData`""
Start-Process powershell -ArgumentList `
    "-NoExit", "-Command", `
    "Write-Host 'Jena Fuseki' -ForegroundColor Yellow; " +
    "& '$fusekiBin' $jenaArgs" `
    -WindowStyle Normal

if (-not (Wait-Http 'http://localhost:3030/$/ping' -timeoutSec 30 -label 'Jena Fuseki')) {
    Write-Fail "Jena Fuseki failed to start. Check the Fuseki window for errors."
    exit 1
}

# ---------------------------------------------------------------------------
# 2. Start ngrok
# ---------------------------------------------------------------------------

Write-Step "Starting ngrok tunnel..."
Start-Process powershell -ArgumentList `
    "-NoExit", "-Command", `
    "Write-Host 'ngrok' -ForegroundColor Magenta; " +
    "ngrok http --url=$NgrokUrl 3031" `
    -WindowStyle Normal

# Poll ngrok local API to confirm tunnel is up
if (-not (Wait-Http 'http://localhost:4040/api/tunnels' -timeoutSec 20 -label 'ngrok tunnel')) {
    Write-Fail "ngrok did not establish a tunnel. Check the ngrok window for errors."
    exit 1
}

# ---------------------------------------------------------------------------
# 3. Start HolonBridge
# ---------------------------------------------------------------------------

Write-Step "Starting HolonBridge (dataset: $Dataset)..."
Start-Process powershell -ArgumentList `
    "-NoExit", "-Command", `
    "Write-Host 'HolonBridge' -ForegroundColor Green; " +
    "cd '$BridgeDir'; node server.js -d $Dataset" `
    -WindowStyle Normal

if (-not (Wait-Http 'http://localhost:3031/health' -timeoutSec 20 -label 'HolonBridge')) {
    Write-Fail "HolonBridge did not start. Check the HolonBridge window for errors."
    exit 1
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

Write-Host ""
Write-Ok "All services running."
Write-Host ""
Write-Host "  Jena Fuseki  : http://localhost:3030"       -ForegroundColor White
Write-Host "  HolonBridge  : http://localhost:3031"       -ForegroundColor White
Write-Host "  ngrok tunnel : https://$NgrokUrl"           -ForegroundColor White
Write-Host "  Health check : http://localhost:3031/health" -ForegroundColor White
Write-Host ""
