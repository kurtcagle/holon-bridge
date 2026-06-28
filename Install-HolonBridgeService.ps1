#Requires -RunAsAdministrator
#Requires -Version 5.1
<#
.SYNOPSIS
    Install-HolonBridgeService.ps1 -- Install HolonBridge as Windows services.

.DESCRIPTION
    Uses NSSM to install two Windows services:

      HolonBridge          -- Jena Fuseki + HolonBridge REST (:3031)
                              Launcher: Start-HolonBridge-Headless.ps1
      HolonbridgeMcpRemote -- MCP remote SSE server (:3032)
                              Launcher: Start-HolonBridgeMcp-Headless.ps1

    ngrok tunnels are NOT managed as services. Start them separately
    (via ngrok or your reverse proxy) before or after service install.

    Run once as Administrator. After install, control with:
        Start-Service   HolonBridge
        Stop-Service    HolonBridge
        Start-Service   HolonbridgeMcpRemote
        Stop-Service    HolonbridgeMcpRemote

.PARAMETER InstallDir
    Directory for launcher scripts, config, and logs.
    Default: C:\ProgramData\HolonBridge

.PARAMETER NssmPath
    Full path to nssm.exe if not in PATH.

.PARAMETER Uninstall
    Remove both services.

.EXAMPLE
    # Install (run as Administrator)
    .\Install-HolonBridgeService.ps1

    # Uninstall
    .\Install-HolonBridgeService.ps1 -Uninstall
#>

[CmdletBinding()]
param(
    [string] $InstallDir = 'C:\ProgramData\HolonBridge',
    [string] $NssmPath   = '',
    [switch] $Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step ([string]$msg) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $msg" -ForegroundColor Cyan }
function Write-Ok   ([string]$msg) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] OK  $msg" -ForegroundColor Green }
function Write-Fail ([string]$msg) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] ERR $msg" -ForegroundColor Red }

# ── Locate NSSM ───────────────────────────────────────────────────────────────

$nssmCmd = Get-Command nssm -ErrorAction SilentlyContinue
$nssm = if ($NssmPath) { $NssmPath } elseif ($nssmCmd) { $nssmCmd.Source } else { $null }

if (-not $nssm) {
    Write-Step "nssm not found -- installing via winget..."
    winget install NSSM.NSSM --silent
    $nssmCmd = Get-Command nssm -ErrorAction SilentlyContinue
    $nssm = if ($nssmCmd) { $nssmCmd.Source } else { $null }
    if (-not $nssm) { Write-Fail "Could not locate nssm. Specify -NssmPath."; exit 1 }
}
Write-Ok "Using nssm: $nssm"

# ── Uninstall ─────────────────────────────────────────────────────────────────

if ($Uninstall) {
    foreach ($svc in @('HolonBridge', 'HolonbridgeMcpRemote')) {
        Write-Step "Removing service '$svc'..."
        & $nssm stop   $svc 2>&1 | Out-Null
        & $nssm remove $svc confirm | Out-Null
        Write-Ok "Removed: $svc"
    }
    exit 0
}

# ── Ensure install directory and launcher scripts ─────────────────────────────

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$logDir = Join-Path $InstallDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$scriptSrc = $PSScriptRoot

foreach ($launcher in @('Start-HolonBridge-Headless.ps1', 'Start-HolonBridgeMcp-Headless.ps1', 'holonbridge.config.ps1')) {
    $src  = Join-Path $scriptSrc $launcher
    $dest = Join-Path $InstallDir $launcher
    if (Test-Path $src) {
        Copy-Item $src $dest -Force
        Write-Ok "Copied: $launcher"
    } elseif (-not (Test-Path $dest)) {
        Write-Step "WARNING: $launcher not found in $scriptSrc"
        Write-Step "         Place it manually at $dest before starting the service."
    }
}

$configDest = Join-Path $InstallDir 'holonbridge.config.ps1'
if (-not (Test-Path $configDest)) {
    @'
# holonbridge.config.ps1 -- edit these values before starting the services
$JenaDir      = 'C:\apache\apache-jena-fuseki-6.1.0'
$JenaData     = 'C:\ProgramData\HolonBridge\databases'
$BridgeDir    = 'C:\ProgramData\HolonBridge'
$McpDir       = "$BridgeDir\mcp-remote"
$Dataset      = 'ds'
$NgrokUrl     = 'yourServer.ngrok.io'
$McpNgrokUrl  = 'yourServer-mcp.ngrok.io'
'@ | Set-Content $configDest -Encoding UTF8
    Write-Ok "Default config written: $configDest"
    Write-Step "IMPORTANT: Edit $configDest before starting services."
}

# ── Helper: install or update one NSSM service ───────────────────────────────

function Install-NssmService ([string]$name, [string]$launcher, [string]$display, [string]$description) {
    $exists = $false
    try { $null = & $nssm status $name 2>&1; $exists = ($LASTEXITCODE -eq 0) } catch { }

    if ($exists) {
        Write-Step "Updating service '$name'..."
        & $nssm stop $name 2>&1 | Out-Null
    } else {
        Write-Step "Installing service '$name'..."
        & $nssm install $name powershell.exe | Out-Null
    }

    & $nssm set $name Application    powershell.exe
    & $nssm set $name AppParameters  "-NonInteractive -ExecutionPolicy Bypass -File `"$launcher`""
    & $nssm set $name AppDirectory   $InstallDir
    & $nssm set $name DisplayName    $display
    & $nssm set $name Description    $description
    & $nssm set $name Start          SERVICE_AUTO_START
    & $nssm set $name ObjectName     LocalSystem
    & $nssm set $name AppStdout      (Join-Path $logDir "$name.log")
    & $nssm set $name AppStderr      (Join-Path $logDir "$name-error.log")
    & $nssm set $name AppRotateFiles 1
    & $nssm set $name AppRotateBytes 10485760
    & $nssm set $name AppRestartDelay 5000
    Write-Ok "Configured: $name"
}

# ── Install HolonBridge service (Fuseki + REST) ───────────────────────────────

Install-NssmService `
    -name        'HolonBridge' `
    -launcher    (Join-Path $InstallDir 'Start-HolonBridge-Headless.ps1') `
    -display     'HolonBridge (Jena + REST)' `
    -description 'Apache Jena Fuseki triplestore and HolonBridge REST API (:3031).'

# ── Install MCP remote service ────────────────────────────────────────────────

Install-NssmService `
    -name        'HolonbridgeMcpRemote' `
    -launcher    (Join-Path $InstallDir 'Start-HolonBridgeMcp-Headless.ps1') `
    -display     'HolonBridge MCP Remote' `
    -description 'HolonBridge MCP remote SSE server for claude.ai (:3032).'

# ── Start both services ───────────────────────────────────────────────────────

Write-Step "Starting HolonBridge..."
& $nssm start HolonBridge

Write-Step "Starting HolonbridgeMcpRemote (waits for HolonBridge to be healthy)..."
& $nssm start HolonbridgeMcpRemote

Start-Sleep -Seconds 3

Write-Host ""
Write-Ok "Services installed and started."
Write-Host ""
Write-Host "  Control commands:" -ForegroundColor White
Write-Host "    Start-Service   HolonBridge"            -ForegroundColor Gray
Write-Host "    Stop-Service    HolonBridge"            -ForegroundColor Gray
Write-Host "    Start-Service   HolonbridgeMcpRemote"   -ForegroundColor Gray
Write-Host "    Stop-Service    HolonbridgeMcpRemote"   -ForegroundColor Gray
Write-Host "    nssm edit       HolonBridge             (GUI config)" -ForegroundColor Gray
Write-Host ""
Write-Host "  Logs: $logDir" -ForegroundColor White
Write-Host "  Config: $configDest" -ForegroundColor White
Write-Host ""
Write-Host "  Note: ngrok tunnels are NOT managed by these services." -ForegroundColor DarkYellow
Write-Host "  Start them separately, or use a reverse proxy instead." -ForegroundColor DarkYellow
Write-Host ""
Write-Host "  To uninstall:" -ForegroundColor White
Write-Host "    .\Install-HolonBridgeService.ps1 -Uninstall" -ForegroundColor Gray
Write-Host ""
