<#
.SYNOPSIS
    Read or set the HolonBridge SHACL validation gate (POST /shacl-mode).

.DESCRIPTION
    With no -Required switch, reports the current state and exits -- safe to run
    any time. With -Required, flips the gate and reports the state before and
    after, so you can see the change actually took.

    The setting is persisted by the bridge in .bridge-session-state.json, so it
    survives a restart. No .env edit is needed, and this same script reverses it.

    Works on Windows PowerShell 5.1 and PowerShell 7+.

.PARAMETER Required
    $true  -- arm the gate: /update rejects payloads that fail SHACL validation.
    $false -- disarm: /update pushes without validating.
    Omit entirely to read the current state without changing it.

.PARAMETER Port
    Bridge port. Defaults to $env:PORT, then 3031 (server.js's own default).

.PARAMETER BridgeHost
    Defaults to localhost.

.PARAMETER Token
    Bearer token. Defaults to $env:BEARER_TOKEN, which is where the bridge
    itself requires it to live.

.EXAMPLE
    .\Set-HolonBridgeShaclMode.ps1
    Reports the current state, changes nothing.

.EXAMPLE
    .\Set-HolonBridgeShaclMode.ps1 -Required $true
    Arms the gate.

.EXAMPLE
    .\Set-HolonBridgeShaclMode.ps1 -Required $false
    Turns it straight back off if something misbehaves.
#>

[CmdletBinding()]
param(
    [Parameter()] [Nullable[bool]] $Required,
    [Parameter()] [int]            $Port       = $(if ($env:PORT) { [int]$env:PORT } else { 3031 }),
    [Parameter()] [string]         $BridgeHost = 'localhost',
    [Parameter()] [string]         $Token      = $env:BEARER_TOKEN
)

$ErrorActionPreference = 'Stop'
$base = "http://${BridgeHost}:${Port}"

if ([string]::IsNullOrWhiteSpace($Token)) {
    Write-Error @"
BEARER_TOKEN is not set in this session.

The bridge requires it as an OS environment variable, so it exists -- but if you
set it after this PowerShell window opened, the window won't see it. Either open
a new terminal, or for this session only:

    `$env:BEARER_TOKEN = '<token>'
"@
    exit 1
}

$headers = @{ Authorization = "Bearer $Token" }

# --- helpers ------------------------------------------------------------------

# PS 5.1 throws a terminating error on any non-2xx and hides the response body;
# PS 7 puts it in ErrorDetails. Read both so a 401 says "401" rather than
# "The remote server returned an error".
function Get-HttpErrorBody {
    param($ErrorRecord)
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        return $ErrorRecord.ErrorDetails.Message
    }
    try {
        $stream = $ErrorRecord.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        return $reader.ReadToEnd()
    } catch {
        return $ErrorRecord.Exception.Message
    }
}

function Get-ShaclState {
    try {
        $d = Invoke-RestMethod -Method Get -Uri "$base/description" -Headers $headers -TimeoutSec 15
        return [pscustomobject]@{
            Required    = [bool]$d.shacl.required
            Graph       = $d.shacl.graph
            TripleCount = $d.shacl.tripleCount
            Dataset     = $d.dataset
            Note        = $d.shacl.note
        }
    } catch {
        Write-Error "Could not reach $base/description -- is the bridge running?`n$(Get-HttpErrorBody $_)"
        exit 1
    }
}

function Write-State {
    param($State, [string]$Label)
    $flag = if ($State.Required) { 'ARMED  (/update validates)' } else { 'off    (/update does not validate)' }
    Write-Host ""
    Write-Host "$Label" -ForegroundColor Cyan
    Write-Host ("  dataset      : {0}" -f $State.Dataset)
    Write-Host ("  shapes graph : {0} ({1} triples)" -f $State.Graph, $State.TripleCount)
    Write-Host ("  SHACL gate   : {0}" -f $flag) -ForegroundColor $(if ($State.Required) { 'Green' } else { 'Yellow' })
}

# --- read ---------------------------------------------------------------------

$before = Get-ShaclState
Write-State -State $before -Label 'Current state'

if ($null -eq $Required) {
    Write-Host ""
    Write-Host "No -Required supplied; nothing changed." -ForegroundColor DarkGray
    Write-Host "Use: .\Set-HolonBridgeShaclMode.ps1 -Required `$true" -ForegroundColor DarkGray
    return
}

if ($before.Required -eq $Required) {
    Write-Host ""
    Write-Host ("Already {0}; nothing to do." -f $(if ($Required) { 'armed' } else { 'off' })) -ForegroundColor DarkGray
    return
}

# Arming against an empty shapes graph would reject every write. The bridge's own
# /description note warns about this; fail here rather than let it bite on the
# first push.
if ($Required -and ($before.TripleCount -eq 0)) {
    Write-Error "Refusing to arm: shapes graph <$($before.Graph)> is empty. Every /update would be rejected."
    exit 1
}

# --- write --------------------------------------------------------------------

try {
    $body = @{ required = $Required } | ConvertTo-Json -Compress
    $resp = Invoke-RestMethod -Method Post -Uri "$base/shacl-mode" `
                              -Headers $headers -ContentType 'application/json' `
                              -Body $body -TimeoutSec 15
    Write-Host ""
    Write-Host "Bridge says: $($resp.message)" -ForegroundColor Green
} catch {
    Write-Error "POST $base/shacl-mode failed.`n$(Get-HttpErrorBody $_)"
    exit 1
}

# Re-read rather than trusting the POST response -- confirms the change is what
# the bridge will actually act on.
$after = Get-ShaclState
Write-State -State $after -Label 'New state'

if ($after.Required -ne $Required) {
    Write-Error "Gate did not change as requested. Expected Required=$Required, bridge reports $($after.Required)."
    exit 1
}

Write-Host ""
if ($after.Required) {
    Write-Host "Gate is armed. To reverse:  .\Set-HolonBridgeShaclMode.ps1 -Required `$false" -ForegroundColor DarkGray
} else {
    Write-Host "Gate is off." -ForegroundColor DarkGray
}
