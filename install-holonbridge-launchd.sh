#!/usr/bin/env bash
# install-holonbridge-launchd.sh -- Install HolonBridge as macOS launchd agents.
#
# Usage:
#   ./install-holonbridge-launchd.sh [OPTIONS]
#
# Options:
#   -d, --dataset DATASET    Default dataset (default: ds)
#   -j, --jena-dir DIR       Jena installation directory
#                            (default: /opt/homebrew/opt/jena)
#   -D, --jena-data DIR      Fuseki databases directory
#                            (default: $HOME/.holonbridge/databases)
#   -b, --bridge-dir DIR     holon-bridge repo root
#                            (default: $HOME/.holonbridge/holon-bridge)
#   -n, --ngrok-url URL      ngrok subdomain for HolonBridge REST :3031
#   -m, --mcp-ngrok-url URL  ngrok subdomain for MCP remote :3032
#   -l, --log-dir DIR        Log directory (default: $HOME/.holonbridge/logs)
#   --skip-ngrok             Omit ngrok plists (reverse-proxy or direct hosting)
#   --system                 Install as system LaunchDaemons (requires sudo)
#   --uninstall              Stop and remove all plists
#   -h, --help               Show this help
#
# Creates five launchd plists (or three with --skip-ngrok):
#
#   io.holonbridge.fuseki        Jena Fuseki triplestore (:3030)
#   io.holonbridge.ngrok         ngrok tunnel → HolonBridge REST (:3031)
#   io.holonbridge.bridge        HolonBridge REST API (:3031)
#   io.holonbridge.ngrok-mcp     ngrok tunnel → MCP remote (:3032)
#   io.holonbridge.mcp-remote    MCP remote SSE server (:3032)
#
# Start the full stack:
#   launchctl start io.holonbridge.fuseki
#   launchctl start io.holonbridge.ngrok       # (if not --skip-ngrok)
#   launchctl start io.holonbridge.bridge
#   launchctl start io.holonbridge.ngrok-mcp   # (if not --skip-ngrok)
#   launchctl start io.holonbridge.mcp-remote
#
# To uninstall:
#   ./install-holonbridge-launchd.sh --uninstall

set -euo pipefail

[[ "$(uname)" != "Darwin" ]] && { echo "macOS only. For Linux use install-holonbridge-service.sh" >&2; exit 1; }

# ── Defaults ──────────────────────────────────────────────────────────────────

DATASET="ds"
JENA_DIR="/opt/homebrew/opt/jena"
JENA_DATA="$HOME/.holonbridge/databases"
BRIDGE_DIR="$HOME/.holonbridge/holon-bridge"
NGROK_URL="yourServer.ngrok.io"
MCP_NGROK_URL="yourServer-mcp.ngrok.io"
LOG_DIR="$HOME/.holonbridge/logs"
SKIP_NGROK=false
SYSTEM_MODE=false
UNINSTALL=false

# ── Argument parsing ──────────────────────────────────────────────────────────

usage() { grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -40; exit 0; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        -d|--dataset)       DATASET="$2";       shift 2 ;;
        -j|--jena-dir)      JENA_DIR="$2";      shift 2 ;;
        -D|--jena-data)     JENA_DATA="$2";     shift 2 ;;
        -b|--bridge-dir)    BRIDGE_DIR="$2";    shift 2 ;;
        -n|--ngrok-url)     NGROK_URL="$2";     shift 2 ;;
        -m|--mcp-ngrok-url) MCP_NGROK_URL="$2"; shift 2 ;;
        -l|--log-dir)       LOG_DIR="$2";       shift 2 ;;
        --skip-ngrok)       SKIP_NGROK=true;    shift ;;
        --system)           SYSTEM_MODE=true;   shift ;;
        --uninstall)        UNINSTALL=true;     shift ;;
        -h|--help)          usage ;;
        *) echo "Unknown option: $1"; usage ;;
    esac
done

MCP_DIR="$BRIDGE_DIR/mcp-remote"

if [[ "$SYSTEM_MODE" == true ]]; then
    [[ $EUID -ne 0 ]] && { echo "--system requires sudo." >&2; exit 1; }
    PLIST_DIR="/Library/LaunchDaemons"
    SCOPE="system"
else
    PLIST_DIR="$HOME/Library/LaunchAgents"
    SCOPE="gui/$(id -u)"
fi

GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
log_step() { echo -e "${CYAN}[$(date '+%H:%M:%S')] $*${NC}"; }
log_ok()   { echo -e "${GREEN}[$(date '+%H:%M:%S')] OK  $*${NC}"; }

# ── Uninstall ─────────────────────────────────────────────────────────────────

if [[ "$UNINSTALL" == true ]]; then
    log_step "Uninstalling HolonBridge launchd services..."
    for label in io.holonbridge.mcp-remote io.holonbridge.ngrok-mcp \
                 io.holonbridge.bridge io.holonbridge.ngrok io.holonbridge.fuseki; do
        launchctl bootout "$SCOPE/$label" 2>/dev/null || true
        rm -f "$PLIST_DIR/$label.plist"
        log_ok "Removed: $label"
    done
    exit 0
fi

# ── Validate dependencies ─────────────────────────────────────────────────────

FUSEKI_BIN="$JENA_DIR/libexec/bin/fuseki-server"
[[ ! -x "$FUSEKI_BIN" ]] && FUSEKI_BIN="$JENA_DIR/bin/fuseki-server"
[[ ! -x "$FUSEKI_BIN" ]] && FUSEKI_BIN=$(command -v fuseki-server 2>/dev/null || true)
[[ -z "$FUSEKI_BIN" || ! -x "$FUSEKI_BIN" ]] && {
    echo "fuseki-server not found. Install: brew install jena" >&2; exit 1
}

NODE_BIN=$(command -v node 2>/dev/null || true)
[[ -z "$NODE_BIN" ]] && { echo "node not found. Install: brew install node" >&2; exit 1; }

if [[ "$SKIP_NGROK" == false ]]; then
    NGROK_BIN=$(command -v ngrok 2>/dev/null || true)
    [[ -z "$NGROK_BIN" ]] && { echo "ngrok not found. Install: brew install ngrok or use --skip-ngrok" >&2; exit 1; }
fi

[[ ! -d "$BRIDGE_DIR" ]]         && { echo "bridge-dir not found: $BRIDGE_DIR" >&2; exit 1; }
[[ ! -f "$BRIDGE_DIR/server.js" ]] && { echo "server.js not found in $BRIDGE_DIR" >&2; exit 1; }
[[ ! -d "$MCP_DIR" ]]            && { echo "mcp-remote dir not found: $MCP_DIR" >&2; exit 1; }

# ── Directories and env file ──────────────────────────────────────────────────

mkdir -p "$LOG_DIR" "$JENA_DATA" "$PLIST_DIR"

ENV_FILE="$HOME/.holonbridge/holonbridge.env"
mkdir -p "$(dirname "$ENV_FILE")"

if [[ ! -f "$ENV_FILE" ]]; then
    cat > "$ENV_FILE" << EOF
# HolonBridge environment -- edit before starting services

JENA_DIR=$JENA_DIR
JENA_DATA=$JENA_DATA
BRIDGE_DIR=$BRIDGE_DIR
MCP_DIR=$MCP_DIR
DATASET=$DATASET

ANTHROPIC_API_KEY=your-anthropic-api-key
FUSEKI_URL=http://localhost:3030
FUSEKI_DATASET=$DATASET
PORT=3031
SHACL_REQUIRED=false

BEARER_TOKEN=your-holonbridge-bearer-token

HOLONBRIDGE_URL=https://$NGROK_URL
HB_BEARER_TOKEN=your-holonbridge-bearer-token
MCP_REMOTE_TOKEN=your-mcp-remote-token
MCP_PORT=3032
MCP_PUBLIC_URL=https://$MCP_NGROK_URL
FUSEKI_GSP=http://localhost:3030/ds/data
EOF
    chmod 600 "$ENV_FILE"
    log_ok "Environment file written: $ENV_FILE"
    echo "  --> Edit $ENV_FILE and set your tokens before starting."
fi

# ── Helper: write a launchd plist ────────────────────────────────────────────

write_plist() {
    local label="$1"; local plist_file="$PLIST_DIR/$label.plist"
    local program_args="$2"
    local working_dir="$3"
    local log_base="$LOG_DIR/$label"

    local env_block
    env_block="    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>"
    while IFS='=' read -r key val; do
        [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
        val="${val%%#*}"; val="${val%"${val##*[![:space:]]}"}")
        env_block+="
        <key>$key</key>
        <string>$val</string>"
    done < "$ENV_FILE"
    env_block+="
    </dict>"

    cat > "$plist_file" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
$program_args
    </array>
$env_block
    <key>WorkingDirectory</key>
    <string>$working_dir</string>
    <key>StandardOutPath</key>
    <string>${log_base}.log</string>
    <key>StandardErrorPath</key>
    <string>${log_base}-error.log</string>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <false/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
EOF
    log_ok "Written: $plist_file"
}

# ── 1. io.holonbridge.fuseki ──────────────────────────────────────────────────

log_step "Writing Fuseki plist..."
write_plist "io.holonbridge.fuseki" \
    "        <string>$FUSEKI_BIN</string>
        <string>--update</string>
        <string>--loc</string>
        <string>$JENA_DATA</string>" \
    "$JENA_DATA"

# ── 2. io.holonbridge.ngrok (optional) ───────────────────────────────────────

if [[ "$SKIP_NGROK" == false ]]; then
    log_step "Writing ngrok (bridge) plist..."
    write_plist "io.holonbridge.ngrok" \
        "        <string>$NGROK_BIN</string>
        <string>http</string>
        <string>--url=$NGROK_URL</string>
        <string>3031</string>" \
        "$HOME"
fi

# ── 3. io.holonbridge.bridge ──────────────────────────────────────────────────

log_step "Writing HolonBridge REST plist..."
write_plist "io.holonbridge.bridge" \
    "        <string>$NODE_BIN</string>
        <string>server.js</string>" \
    "$BRIDGE_DIR"

# ── 4. io.holonbridge.ngrok-mcp (optional) ───────────────────────────────────

if [[ "$SKIP_NGROK" == false ]]; then
    log_step "Writing ngrok (MCP) plist..."
    write_plist "io.holonbridge.ngrok-mcp" \
        "        <string>$NGROK_BIN</string>
        <string>http</string>
        <string>--url=$MCP_NGROK_URL</string>
        <string>3032</string>" \
        "$HOME"
fi

# ── 5. io.holonbridge.mcp-remote ─────────────────────────────────────────────

log_step "Writing MCP remote plist..."
write_plist "io.holonbridge.mcp-remote" \
    "        <string>$NODE_BIN</string>
        <string>holonbridge-mcp-remote.js</string>" \
    "$MCP_DIR"

# ── Load plists ───────────────────────────────────────────────────────────────

log_step "Loading plists into launchd..."
for plist in "$PLIST_DIR/io.holonbridge.fuseki.plist" \
             "$PLIST_DIR/io.holonbridge.bridge.plist" \
             "$PLIST_DIR/io.holonbridge.mcp-remote.plist"; do
    label=$(basename "$plist" .plist)
    launchctl bootout "$SCOPE/$label" 2>/dev/null || true
    launchctl bootstrap "$SCOPE" "$plist"
    log_ok "Loaded: $label"
done

if [[ "$SKIP_NGROK" == false ]]; then
    for plist in "$PLIST_DIR/io.holonbridge.ngrok.plist" \
                 "$PLIST_DIR/io.holonbridge.ngrok-mcp.plist"; do
        label=$(basename "$plist" .plist)
        launchctl bootout "$SCOPE/$label" 2>/dev/null || true
        launchctl bootstrap "$SCOPE" "$plist"
        log_ok "Loaded: $label"
    done
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
log_ok "HolonBridge launchd services installed."
echo ""
echo "  Start all services (in order):"
echo "    launchctl start io.holonbridge.fuseki"
[[ "$SKIP_NGROK" == false ]] && echo "    launchctl start io.holonbridge.ngrok"
echo "    launchctl start io.holonbridge.bridge"
[[ "$SKIP_NGROK" == false ]] && echo "    launchctl start io.holonbridge.ngrok-mcp"
echo "    launchctl start io.holonbridge.mcp-remote"
echo ""
echo "  Stop all:"
echo "    launchctl stop io.holonbridge.mcp-remote"
[[ "$SKIP_NGROK" == false ]] && echo "    launchctl stop io.holonbridge.ngrok-mcp"
echo "    launchctl stop io.holonbridge.bridge"
[[ "$SKIP_NGROK" == false ]] && echo "    launchctl stop io.holonbridge.ngrok"
echo "    launchctl stop io.holonbridge.fuseki"
echo ""
echo "  Logs:"
echo "    tail -f $LOG_DIR/io.holonbridge.bridge.log"
echo "    tail -f $LOG_DIR/io.holonbridge.mcp-remote.log"
echo "    tail -f $LOG_DIR/io.holonbridge.fuseki.log"
echo ""
echo "  Config: $ENV_FILE"
grep -q 'your-' "$ENV_FILE" 2>/dev/null && \
    echo "  WARNING: Edit $ENV_FILE -- placeholder values still present."
echo ""
echo "  To uninstall:"
echo "    ./install-holonbridge-launchd.sh --uninstall"
echo ""
