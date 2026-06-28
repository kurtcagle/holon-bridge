#Requires -Version 5.1
# Start-HolonBridgeMcp-Headless.ps1
# Headless launcher for the HolonbridgeMcpRemote NSSM service.
# Waits for HolonBridge REST to be healthy, then starts the MCP remote.
# Edit holonbridge.config.ps1 to change paths and settings.

$cfg = Join-Path $PSScriptRoot 'holonbridge.config.ps1'
if (Test-Path $cfg) { . $cfg } else {
    Write-Error "Config file not found: $cfg"; exit 1
}

$McpDir  = if ($McpDir) { $McpDir } else { Join-Path $BridgeDir 'mcp-remote' }
$LogDir  = Join-Path $PSScriptRoot 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$mcpLog  = Join-Path $LogDir 'holonbridge-mcp-remote.log'

function Log ([string]$msg) {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg" | Add-Content $mcpLog
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

Log "=== HolonBridge MCP remote service start ==="
Log "McpDir : $McpDir"

# Wait for HolonBridge REST to be healthy before starting the MCP remote
Log "Waiting for HolonBridge REST (:3031)..."
if (-not (Wait-Http 'http://localhost:3031/health' 120)) {
    Log "ERROR: HolonBridge REST not reachable after 120s. Exiting."
    exit 1
}
Log "HolonBridge REST is up."

if (-not (Test-Path "$McpDir\holonbridge-mcp-remote.js")) {
    Log "ERROR: holonbridge-mcp-remote.js not found in $McpDir"; exit 1
}

# Run MCP remote in foreground — NSSM tracks this process
Log "Starting MCP remote..."
Set-Location $McpDir
& node holonbridge-mcp-remote.js 2>&1 | ForEach-Object {
    $_ | Add-Content $mcpLog
    $_
}

Log "MCP remote exited."
