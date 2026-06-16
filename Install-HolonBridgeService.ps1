#Requires -RunAsAdministrator
#Requires -Version 5.1
<#
.SYNOPSIS
    Install-HolonBridgeService.ps1 -- Install HolonBridge as a Windows service.

.DESCRIPTION
    Uses NSSM (Non-Sucking Service Manager) to register a single Windows service
    that runs a headless launcher script (Start-HolonBridge-Headless.ps1).
    All three processes (Jena, ngrok, HolonBridge) are managed as child processes
    of that script, with stdout/stderr redirected to log files.

    Run this script once as Administrator to install.  After that, the service
    starts automatically on boot and can be controlled via:
        Start-Service HolonBridge
        Stop-Service  HolonBridge
        Restart-Service HolonBridge

.PARAMETER ServiceName
    Windows service name. Default: HolonBridge

.PARAMETER InstallDir
    Directory containing the launcher scripts and config.
    Default: C:\ProgramData\HolonBridge

.PARAMETER NssmPath
    Full path to nssm.exe if not in PATH.

.PARAMETER Uninstall
    Remove the service instead of installing it.

.EXAMPLE
    # Install (run as Administrator)
    .\Install-HolonBridgeService.ps1

    # Uninstall
    .\Install-HolonBridgeService.ps1 -Uninstall
#>

[CmdletBinding()]
param(
    [string] $ServiceName = 'HolonBridge',
    [string] $InstallDir  = 'C:\ProgramData\HolonBridge',
    [string] $NssmPath    = '',
    [switch] $Uninstall
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

# ---------------------------------------------------------------------------
# Locate NSSM
# ---------------------------------------------------------------------------

$nssmCmd = Get-Command nssm -ErrorAction SilentlyContinue
$nssm = if ($NssmPath) { $NssmPath } elseif ($nssmCmd) { $nssmCmd.Source } else { $null }

if (-not $nssm) {
    Write-Step "nssm not found. Installing via winget..."
    winget install NSSM.NSSM --silent
    $nssmCmd = Get-Command nssm -ErrorAction SilentlyContinue
    $nssm = if ($nssmCmd) { $nssmCmd.Source } else { $null }
    if (-not $nssm) {
        Write-Fail "Could not locate nssm after install. Specify -NssmPath."
        exit 1
    }
}

Write-Ok "Using nssm: $nssm"

# ---------------------------------------------------------------------------
# Uninstall path
# ---------------------------------------------------------------------------

if ($Uninstall) {
    Write-Step "Stopping and removing service '$ServiceName'..."
    & $nssm stop    $ServiceName 2>&1 | Out-Null
    & $nssm remove  $ServiceName confirm | Out-Null
    Write-Ok "Service '$ServiceName' removed."
    exit 0
}

# ---------------------------------------------------------------------------
# Ensure install directory exists and headless launcher is present
# ---------------------------------------------------------------------------

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$headlessScript = Join-Path $InstallDir 'Start-HolonBridge-Headless.ps1'
$logDir         = Join-Path $InstallDir 'logs'
$configFile     = Join-Path $InstallDir 'holonbridge.config.ps1'

if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

# Write the headless launcher if it doesn't already exist
if (-not (Test-Path $headlessScript)) {
    Write-Step "Writing headless launcher to $headlessScript ..."
    @'
#Requires -Version 5.1
# Start-HolonBridge-Headless.ps1
# Headless service launcher -- all output goes to log files.
# Edit holonbridge.config.ps1 to change paths and settings.

$cfg = Join-Path $PSScriptRoot 'holonbridge.config.ps1'
if (Test-Path $cfg) { . $cfg } else {
    Write-Error "Config file not found: $cfg"
    exit 1
}

$LogDir  = Join-Path $PSScriptRoot 'logs'
$fusekiLog   = Join-Path $LogDir 'fuseki.log'
$ngrokLog    = Join-Path $LogDir 'ngrok.log'
$bridgeLog   = Join-Path $LogDir 'holonbridge.log'

function Wait-Http ([string]$url, [int]$timeoutSec = 30) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -EA Stop
            if ($r.StatusCode -lt 400) { return $true }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# 1. Jena Fuseki
"[$(Get-Date)] Starting Jena Fuseki..." | Add-Content $fusekiLog
$fuseki = Start-Process -FilePath (Join-Path $JenaDir 'bin\fuseki-server.bat') `
    -ArgumentList "--update --loc `"$JenaData`"" `
    -RedirectStandardOutput $fusekiLog `
    -RedirectStandardError  $fusekiLog `
    -NoNewWindow -PassThru
if (-not (Wait-Http 'http://localhost:3030/$/ping' 60)) {
    "[$(Get-Date)] ERROR: Fuseki did not start." | Add-Content $fusekiLog; exit 1
}

# 2. ngrok
"[$(Get-Date)] Starting ngrok..." | Add-Content $ngrokLog
$ngrok = Start-Process -FilePath 'ngrok' `
    -ArgumentList "http --url=$NgrokUrl 3031" `
    -RedirectStandardOutput $ngrokLog `
    -RedirectStandardError  $ngrokLog `
    -NoNewWindow -PassThru
if (-not (Wait-Http 'http://localhost:4040/api/tunnels' 20)) {
    "[$(Get-Date)] ERROR: ngrok did not start." | Add-Content $ngrokLog; exit 1
}

# 3. HolonBridge (foreground so NSSM can track/restart it)
"[$(Get-Date)] Starting HolonBridge (dataset: $Dataset)..." | Add-Content $bridgeLog
Set-Location $BridgeDir
& node server.js -d $Dataset 2>&1 | Tee-Object -FilePath $bridgeLog -Append

# If HolonBridge exits, kill children so NSSM restarts cleanly
"[$(Get-Date)] HolonBridge exited -- stopping child processes." | Add-Content $bridgeLog
@($fuseki, $ngrok) | Where-Object { $_ -and -not $_.HasExited } | ForEach-Object { $_.Kill() }
'@ | Set-Content $headlessScript -Encoding UTF8
    Write-Ok "Headless launcher written."
}

# Write default config if it doesn't exist
if (-not (Test-Path $configFile)) {
    Write-Step "Writing default config to $configFile ..."
    @'
# holonbridge.config.ps1
# Edit these paths to match your environment.

$JenaDir   = 'C:\jena'
$JenaData  = 'C:\ProgramData\HolonBridge\databases'
$BridgeDir = 'C:\ProgramData\HolonBridge\chloe\projects\holonbridge'
$NgrokUrl  = 'kurtcagle.ngrok.io'
$Dataset   = 'ds'
'@ | Set-Content $configFile -Encoding UTF8
    Write-Ok "Config written. Edit $configFile before starting the service."
}

# ---------------------------------------------------------------------------
# Install / update the service via NSSM
# ---------------------------------------------------------------------------

# Check if service already exists by exit code (avoids stderr noise)
$serviceExists = $false
try {
    $null = & $nssm status $ServiceName 2>&1
    $serviceExists = ($LASTEXITCODE -eq 0)
} catch { $serviceExists = $false }

if ($serviceExists) {
    Write-Step "Service '$ServiceName' already exists -- updating..."
    & $nssm stop $ServiceName 2>&1 | Out-Null
} else {
    Write-Step "Installing service '$ServiceName'..."
    & $nssm install $ServiceName powershell.exe | Out-Null
}

# Configure NSSM
& $nssm set $ServiceName Application      powershell.exe
& $nssm set $ServiceName AppParameters   "-NonInteractive -ExecutionPolicy Bypass -File `"$headlessScript`""
& $nssm set $ServiceName AppDirectory    $InstallDir
& $nssm set $ServiceName DisplayName     "HolonBridge (Jena + ngrok)"
& $nssm set $ServiceName Description     "HolonBridge RDF bridge with Jena Fuseki triplestore and ngrok tunnel."
& $nssm set $ServiceName Start           SERVICE_AUTO_START
& $nssm set $ServiceName ObjectName      LocalSystem   # or a dedicated service account
& $nssm set $ServiceName AppStdout       (Join-Path $logDir 'service.log')
& $nssm set $ServiceName AppStderr       (Join-Path $logDir 'service-error.log')
& $nssm set $ServiceName AppRotateFiles  1
& $nssm set $ServiceName AppRotateBytes  10485760      # rotate at 10 MB

# Restart policy: restart after 5s on failure, reset after 1 hour
& $nssm set $ServiceName AppRestartDelay 5000

Write-Ok "Service configured."

# ---------------------------------------------------------------------------
# Start the service
# ---------------------------------------------------------------------------

Write-Step "Starting service '$ServiceName'..."
& $nssm start $ServiceName

Start-Sleep -Seconds 3
$status = (& $nssm status $ServiceName 2>&1) | Where-Object { $_ -notmatch 'error|fail' } | Select-Object -First 1
Write-Host ""
Write-Ok "Service '$ServiceName' status: $status"
Write-Host ""
Write-Host "  Manage with:" -ForegroundColor White
Write-Host "    Start-Service   $ServiceName" -ForegroundColor Gray
Write-Host "    Stop-Service    $ServiceName" -ForegroundColor Gray
Write-Host "    Restart-Service $ServiceName" -ForegroundColor Gray
Write-Host "    nssm edit       $ServiceName   (GUI config)" -ForegroundColor Gray
Write-Host ""
Write-Host "  Logs: $logDir" -ForegroundColor White
Write-Host "  Config: $configFile" -ForegroundColor White
Write-Host ""
Write-Host "  To uninstall:" -ForegroundColor White
Write-Host "    .\Install-HolonBridgeService.ps1 -Uninstall" -ForegroundColor Gray
Write-Host ""

