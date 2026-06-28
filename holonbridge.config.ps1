# holonbridge.config.ps1
# Edit these paths and URLs to match your environment.
# Sourced by Start-HolonBridge.ps1 and the headless service launchers.

# ── Paths ─────────────────────────────────────────────────────────────────────
$JenaDir   = 'C:\apache\apache-jena-fuseki-6.1.0'   # Jena installation root
$JenaData  = 'C:\ProgramData\HolonBridge\databases'  # Fuseki persistent data
$BridgeDir = 'C:\ProgramData\HolonBridge'            # holon-bridge repo root
$McpDir    = "$BridgeDir\mcp-remote"                 # mcp-remote subdirectory

# ── Dataset ───────────────────────────────────────────────────────────────────
$Dataset   = 'ds'   # default Fuseki dataset name

# ── Public URLs ───────────────────────────────────────────────────────────────
# Replace with your own ngrok reserved subdomains, or your own domain names
# if you are hosting on a public server (ngrok is not required in that case).
$NgrokUrl     = 'yourServer.ngrok.io'      # HolonBridge REST  :3031
$McpNgrokUrl  = 'yourServer-mcp.ngrok.io' # MCP remote        :3032
