#!/usr/bin/env bash
# install-holonbridge-launchd.sh -- Install HolonBridge as macOS launchd agents.
#
# Usage:
#   ./install-holonbridge-launchd.sh [OPTIONS]
#
# Options:
#   -d, --dataset DATASET    Default dataset (default: ds)
#   -j, --jena-dir DIR       Jena installation directory (default: /opt/homebrew/opt/jena)
#   -D, --jena-data DIR      Fuseki databases directory (default: $HOME/.holonbridge/databases)
#   -b, --bridge-dir DIR     HolonBridge project directory (default: $HOME/.holonbridge/holon-bridge)
#   -n, --ngrok-url URL      Reserved ngrok subdomain (default: kurtcagle.ngrok.io)
#   -l, --log-dir DIR        Log directory (default: $HOME/.holonbridge/logs)
#   --system                 Install as system daemons in /Library/LaunchDaemons (requires sudo)
#   --uninstall              Stop and remove the launchd agents/daemons
#   -h, --help               Show this help
#
# By default installs as user LaunchAgents (~/Library/LaunchAgents), which run
# when the user is logged in.  Use --system for boot-time daemons (requires sudo).
#
# Creates three launchd plists, in dependency order:
#
#   io.holonbridge.fuseki.plist         -- Jena Fuseki triplestore
#   io.holonbridge.ngrok.plist          -- ngrok tunnel
#   io.holonbridge.bridge.plist         -- HolonBridge Node.js server
#
# After install:
#   launchctl start io.holonbridge.bridge   (starts bridge; Fuseki + ngrok already running)
#   launchctl stop  io.holonbridge.bridge
#   tail -f $HOME/.holonbridge/logs/holonbridge.log
#   tail -f $HOME/.holonbridge/logs/fuseki.log
#   tail -f $HOME/.holonbridge/logs/ngrok.log
#
# To uninstall:
#   ./install-holonbridge-launchd.sh --uninstall

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

DATASET="ds"
JENA_DIR="/opt/homebrew/opt/jena"
JENA_DATA="$HOME/.holonbridge/databases"
BRIDGE_DIR="$HOME/.holonbridge/holon-bridge"
NGROK_URL="kurtcagle.ngrok.io"
LOG_DIR="$HOME/.holonbridge/logs"
SYSTEM_MODE=false
UNINSTALL=false

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

usage() {
    grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -35
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -d|--dataset)    DATASET="$2";    shift 2 ;;
        -j|--jena-dir)   JENA_DIR="$2";   shift 2 ;;
        -D|--jena-data)  JENA_DATA="$2";  shift 2 ;;
        -b|--bridge-dir) BRIDGE_DIR="$2"; shift 2 ;;
        -n|--ngrok-url)  NGROK_URL="$2";  shift 2 ;;
        -l|--log-dir)    LOG_DIR="$2";    shift 2 ;;
        --system)        SYSTEM_MODE=true; shift ;;
        --uninstall)     UNINSTALL=true;   shift ;;
        -h|--help)       usage ;;
        *) echo "Unknown option: $1"; usage ;;
    esac
done

# ---------------------------------------------------------------------------
# Platform check
# ---------------------------------------------------------------------------

if [[ "$(uname)" != "Darwin" ]]; then
    echo "This script is for macOS only. For Linux, use install-holonbridge-service.sh" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Install paths
# ---------------------------------------------------------------------------

if [[ "$SYSTEM_MODE" == true ]]; then
    if [[ $EUID -ne 0 ]]; then
        echo "Error: --system mode requires sudo." >&2
        exit 1
    fi
    PLIST_DIR="/Library/LaunchDaemons"
    LAUNCHCTL_SCOPE="system"
else
    PLIST_DIR="$HOME/Library/LaunchAgents"
    LAUNCHCTL_SCOPE="gui/$(id -u)"
fi

PLIST_FUSEKI="$PLIST_DIR/io.holonbridge.fuseki.plist"
PLIST_NGROK="$PLIST_DIR/io.holonbridge.ngrok.plist"
PLIST_BRIDGE="$PLIST_DIR/io.holonbridge.bridge.plist"

# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

log_step() { echo -e "${CYAN}[$(date '+%H:%M:%S')] $*${NC}"; }
log_ok()   { echo -e "${GREEN}[$(date '+%H:%M:%S')] OK  $*${NC}"; }
log_err()  { echo -e "${RED}[$(date '+%H:%M:%S')] ERR $*${NC}" >&2; }

# ---------------------------------------------------------------------------
# Uninstall path
# ---------------------------------------------------------------------------

if [[ "$UNINSTALL" == true ]]; then
    log_step "Uninstalling HolonBridge launchd services..."
    for label in io.holonbridge.bridge io.holonbridge.ngrok io.holonbridge.fuseki; do
        if launchctl print "$LAUNCHCTL_SCOPE/$label" &>/dev/null 2>&1; then
            launchctl bootout "$LAUNCHCTL_SCOPE/$label" 2>/dev/null || true
            log_ok "Unloaded $label"
        else
            echo "  $label not loaded -- skipping"
        fi
    done
    rm -f "$PLIST_FUSEKI" "$PLIST_NGROK" "$PLIST_BRIDGE"
    log_ok "Plist files removed."
    echo ""
    echo "  Databases and logs retained at:"
    echo "    $JENA_DATA"
    echo "    $LOG_DIR"
    echo ""
    exit 0
fi

# ---------------------------------------------------------------------------
# Validate dependencies
# ---------------------------------------------------------------------------

FUSEKI_BIN="$JENA_DIR/libexec/bin/fuseki-server"
# Homebrew may put it in libexec or bin depending on version
if [[ ! -x "$FUSEKI_BIN" ]]; then
    FUSEKI_BIN="$JENA_DIR/bin/fuseki-server"
fi
if [[ ! -x "$FUSEKI_BIN" ]]; then
    # Try searching PATH
    FUSEKI_BIN=$(command -v fuseki-server 2>/dev/null || true)
fi
if [[ -z "$FUSEKI_BIN" || ! -x "$FUSEKI_BIN" ]]; then
    log_err "fuseki-server not found. Install via Homebrew: brew install jena"
    log_err "Or set --jena-dir to your Jena installation."
    exit 1
fi

NODE_BIN=$(command -v node 2>/dev/null || true)
if [[ -z "$NODE_BIN" ]]; then
    log_err "node not found. Install via: brew install node"
    exit 1
fi

NGROK_BIN=$(command -v ngrok 2>/dev/null || true)
if [[ -z "$NGROK_BIN" ]]; then
    log_err "ngrok not found. Install via: brew install ngrok"
    exit 1
fi

if [[ ! -d "$BRIDGE_DIR" ]]; then
    log_err "HolonBridge directory not found: $BRIDGE_DIR"
    log_err "Clone the repo: git clone https://github.com/kurtcagle/holon-bridge $BRIDGE_DIR"
    exit 1
fi

# ---------------------------------------------------------------------------
# Create directories
# ---------------------------------------------------------------------------

mkdir -p "$LOG_DIR" "$JENA_DATA" "$PLIST_DIR"

# ---------------------------------------------------------------------------
# Environment file
# ---------------------------------------------------------------------------

ENV_FILE="$HOME/.holonbridge/holonbridge.env"
mkdir -p "$(dirname "$ENV_FILE")"

if [[ ! -f "$ENV_FILE" ]]; then
    cat > "$ENV_FILE" << EOF
# HolonBridge environment configuration
# Edit these values, then reload the services.

JENA_DIR=$JENA_DIR
JENA_DATA=$JENA_DATA
BRIDGE_DIR=$BRIDGE_DIR
NGROK_URL=$NGROK_URL
DATASET=$DATASET

# Anthropic API key (required for NL query)
ANTHROPIC_API_KEY=your-key-here

# HolonBridge server settings
JENA_BASE=http://localhost:3030
JENA_DATASET=$DATASET
PORT=3031
MAX_RETRIES=2
CLAUDE_MODEL=claude-sonnet-4-6
SHACL_REQUIRED=false
LOG_SPARQL=false
LOG_PROMPTS=false
EOF
    chmod 600 "$ENV_FILE"
    log_ok "Environment file written: $ENV_FILE"
    echo "  --> Edit ANTHROPIC_API_KEY before starting."
fi

# ---------------------------------------------------------------------------
# Helper: build EnvironmentVariables XML block from env file
# ---------------------------------------------------------------------------

env_xml() {
    echo "    <key>EnvironmentVariables</key>"
    echo "    <dict>"
    # Always include PATH so node/fuseki can find each other
    echo "        <key>PATH</key>"
    echo "        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>"
    while IFS='=' read -r key val; do
        [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
        # Strip inline comments
        val="${val%%#*}"
        val="${val%"${val##*[![:space:]]}"}"   # trim trailing whitespace
        echo "        <key>$key</key>"
        echo "        <string>$val</string>"
    done < "$ENV_FILE"
    echo "    </dict>"
}

# ---------------------------------------------------------------------------
# 1. io.holonbridge.fuseki.plist
# ---------------------------------------------------------------------------

log_step "Writing Jena Fuseki plist..."

cat > "$PLIST_FUSEKI" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>io.holonbridge.fuseki</string>

    <key>ProgramArguments</key>
    <array>
        <string>$FUSEKI_BIN</string>
        <string>--update</string>
        <string>--loc</string>
        <string>$JENA_DATA</string>
    </array>

$(env_xml)

    <key>WorkingDirectory</key>
    <string>$JENA_DATA</string>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/fuseki.log</string>

    <key>StandardErrorPath</key>
    <string>$LOG_DIR/fuseki-error.log</string>

    <key>KeepAlive</key>
    <true/>

    <key>RunAtLoad</key>
    <false/>

    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
EOF

log_ok "Written: $PLIST_FUSEKI"

# ---------------------------------------------------------------------------
# 2. io.holonbridge.ngrok.plist
# ---------------------------------------------------------------------------

log_step "Writing ngrok plist..."

cat > "$PLIST_NGROK" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>io.holonbridge.ngrok</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NGROK_BIN</string>
        <string>http</string>
        <string>--url=$NGROK_URL</string>
        <string>3031</string>
    </array>

$(env_xml)

    <key>StandardOutPath</key>
    <string>$LOG_DIR/ngrok.log</string>

    <key>StandardErrorPath</key>
    <string>$LOG_DIR/ngrok-error.log</string>

    <key>KeepAlive</key>
    <true/>

    <key>RunAtLoad</key>
    <false/>

    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
EOF

log_ok "Written: $PLIST_NGROK"

# ---------------------------------------------------------------------------
# 3. io.holonbridge.bridge.plist
# ---------------------------------------------------------------------------

log_step "Writing HolonBridge plist..."

cat > "$PLIST_BRIDGE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>io.holonbridge.bridge</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>server.js</string>
        <string>-d</string>
        <string>$DATASET</string>
    </array>

$(env_xml)

    <key>WorkingDirectory</key>
    <string>$BRIDGE_DIR</string>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/holonbridge.log</string>

    <key>StandardErrorPath</key>
    <string>$LOG_DIR/holonbridge-error.log</string>

    <key>KeepAlive</key>
    <true/>

    <key>RunAtLoad</key>
    <false/>

    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>SoftResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key>
        <integer>65536</integer>
    </dict>
</dict>
</plist>
EOF

log_ok "Written: $PLIST_BRIDGE"

# ---------------------------------------------------------------------------
# Load into launchd
# ---------------------------------------------------------------------------

log_step "Loading plists into launchd..."

for plist in "$PLIST_FUSEKI" "$PLIST_NGROK" "$PLIST_BRIDGE"; do
    label=$(basename "$plist" .plist)
    # Unload first if already registered (idempotent reinstall)
    launchctl bootout "$LAUNCHCTL_SCOPE/$label" 2>/dev/null || true
    launchctl bootstrap "$LAUNCHCTL_SCOPE" "$plist"
    log_ok "Loaded: $label"
done

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
log_ok "HolonBridge launchd agents installed."
echo ""
echo "  Start all three services (in order):"
echo "    launchctl start io.holonbridge.fuseki"
echo "    launchctl start io.holonbridge.ngrok"
echo "    launchctl start io.holonbridge.bridge"
echo ""
echo "  Or use the start script:"
echo "    ./start-holonbridge.sh -b $BRIDGE_DIR"
echo ""
echo "  Stop:"
echo "    launchctl stop io.holonbridge.bridge"
echo "    launchctl stop io.holonbridge.ngrok"
echo "    launchctl stop io.holonbridge.fuseki"
echo ""
echo "  Status:"
echo "    launchctl print gui/\$(id -u)/io.holonbridge.bridge"
echo ""
echo "  Logs:"
echo "    tail -f $LOG_DIR/holonbridge.log"
echo "    tail -f $LOG_DIR/fuseki.log"
echo "    tail -f $LOG_DIR/ngrok.log"
echo ""
echo "  Config: $ENV_FILE"
if grep -q 'your-key-here' "$ENV_FILE" 2>/dev/null; then
    echo "  WARNING: Set ANTHROPIC_API_KEY in $ENV_FILE before starting."
fi
echo ""
echo "  To uninstall:"
echo "    ./install-holonbridge-launchd.sh --uninstall"
echo ""
