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
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$fusekiLog   = Join-Path $LogDir 'fuseki.log'
$ngrokLog    = Join-Path $LogDir 'ngrok.log'
$bridgeLog   = Join-Path $LogDir 'holonbridge.log'
"[$(Get-Date)] === HolonBridge startup ===" | Add-Content $bridgeLog
"[$(Get-Date)] PSScriptRoot: $PSScriptRoot"  | Add-Content $bridgeLog
"[$(Get-Date)] JenaDir:      $JenaDir"       | Add-Content $bridgeLog
"[$(Get-Date)] JenaData:     $JenaData"      | Add-Content $bridgeLog
"[$(Get-Date)] BridgeDir:    $BridgeDir"     | Add-Content $bridgeLog
"[$(Get-Date)] Dataset:      $Dataset"       | Add-Content $bridgeLog
"[$(Get-Date)] Script loaded OK -- defining functions..." | Add-Content $bridgeLog
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
# 1. Jena Fuseki (assumed to be running as a separate service)
"[$(Get-Date)] Checking Fuseki is reachable..." | Add-Content $fusekiLog
if (-not (Wait-Http 'http://localhost:3030/$/ping' 30)) {
    "[$(Get-Date)] ERROR: Fuseki not reachable on :3030 -- is the Fuseki service running?" | Add-Content $fusekiLog; exit 1
}
"[$(Get-Date)] Fuseki is up." | Add-Content $fusekiLog
$fuseki = $null   # no child process to kill on exit
# 2. ngrok (running independently -- no check needed)
"[$(Get-Date)] Assuming ngrok is running independently." | Add-Content $ngrokLog
$ngrok = $null
# 3. HolonBridge (foreground so NSSM can track/restart it)
"[$(Get-Date)] Starting HolonBridge (dataset: $Dataset)..." | Add-Content $bridgeLog
Set-Location $BridgeDir
& node server.js -d $Dataset 2>&1 | Tee-Object -FilePath $bridgeLog -Append
# If HolonBridge exits, kill children so NSSM restarts cleanly
"[$(Get-Date)] HolonBridge exited -- stopping child processes." | Add-Content $bridgeLog
@($fuseki, $ngrok) | Where-Object { $_ -and -not $_.HasExited } | ForEach-Object { $_.Kill() }