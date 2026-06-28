#Requires -Version 5.1
# Start-HolonBridge-Headless.ps1
# Headless launcher for the HolonBridge NSSM service.
# Starts Jena Fuseki and HolonBridge REST; output goes to log files.
# The MCP remote is managed by the separate HolonbridgeMcpRemote service.
# Edit holonbridge.config.ps1 to change paths and settings.

$cfg = Join-Path $PSScriptRoot 'holonbridge.config.ps1'
if (Test-Path $cfg) { . $cfg } else {
    Write-Error "Config file not found: $cfg"; exit 1
}

$LogDir    = Join-Path $PSScriptRoot 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

$fusekiLog = Join-Path $LogDir 'fuseki.log'
$bridgeLog = Join-Path $LogDir 'holonbridge.log'

function Log ([string]$file, [string]$msg) {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg" | Add-Content $file
}

function Wait-Http ([string]$url, [int]$timeoutSec = 60) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -EA Stop
            if ($r.StatusCode -lt 400) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

Log $bridgeLog "=== HolonBridge service start ==="
Log $bridgeLog "BridgeDir : $BridgeDir"
Log $bridgeLog "Dataset   : $Dataset"

# ── 1. Jena Fuseki ────────────────────────────────────────────────────────────

$fusekiBin = Join-Path $JenaDir 'bin\fuseki-server.bat'
if (-not (Test-Path $fusekiBin)) {
    Log $bridgeLog "ERROR: fuseki-server.bat not found at $fusekiBin"; exit 1
}

Log $fusekiLog "Starting Jena Fuseki..."
$fuseki = Start-Process -FilePath $fusekiBin `
    -ArgumentList "--update --loc `"$JenaData`"" `
    -RedirectStandardOutput $fusekiLog `
    -RedirectStandardError  $fusekiLog `
    -NoNewWindow -PassThru

if (-not (Wait-Http 'http://localhost:3030/$/ping' 60)) {
    Log $fusekiLog "ERROR: Fuseki did not start within 60s."
    Log $bridgeLog "ERROR: Fuseki did not start."; exit 1
}
Log $bridgeLog "Fuseki is up."

# ── 2. HolonBridge REST (foreground — NSSM tracks this process) ───────────────

Log $bridgeLog "Starting HolonBridge REST..."
Set-Location $BridgeDir
& node server.js 2>&1 | ForEach-Object {
    $_ | Add-Content $bridgeLog
    $_
}

# If server.js exits, kill Fuseki so NSSM restarts the whole service cleanly
Log $bridgeLog "HolonBridge REST exited — stopping Fuseki."
if ($fuseki -and -not $fuseki.HasExited) { $fuseki.Kill() }
