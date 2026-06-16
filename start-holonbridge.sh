#!/usr/bin/env bash
# start-holonbridge.sh -- Launch Jena Fuseki, ngrok, and HolonBridge.
#
# Usage:
#   ./start-holonbridge.sh [OPTIONS]
#
# Options:
#   -d, --dataset DATASET    Initial dataset to activate (default: ds)
#   -j, --jena-dir DIR       Jena installation directory (default: /opt/jena)
#   -D, --jena-data DIR      Fuseki databases directory (default: /var/lib/holonbridge/databases)
#   -b, --bridge-dir DIR     HolonBridge project directory
#   -n, --ngrok-url URL      Reserved ngrok subdomain (default: kurtcagle.ngrok.io)
#   -l, --log-dir DIR        Log directory (default: /var/log/holonbridge)
#   -h, --help               Show this help
#
# Requires: java, node, ngrok, curl
#
# Each service runs in a new terminal window if a terminal emulator is found
# (gnome-terminal, xterm, konsole).  In a headless environment all three run
# as background processes with logs written to --log-dir.

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

DATASET="ds"
JENA_DIR="/opt/jena"
JENA_DATA="/var/lib/holonbridge/databases"
BRIDGE_DIR="/opt/holonbridge/chloe/projects/holonbridge"
NGROK_URL="kurtcagle.ngrok.io"
LOG_DIR="/var/log/holonbridge"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

usage() {
    grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -20
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
        -h|--help)       usage ;;
        *) echo "Unknown option: $1"; usage ;;
    esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

log_step() { echo -e "${CYAN}[$(date '+%H:%M:%S')] $*${NC}"; }
log_ok()   { echo -e "${GREEN}[$(date '+%H:%M:%S')] OK  $*${NC}"; }
log_err()  { echo -e "${RED}[$(date '+%H:%M:%S')] ERR $*${NC}" >&2; }

wait_http() {
    local url="$1"
    local label="${2:-$url}"
    local timeout="${3:-30}"
    log_step "Waiting for $label ..."
    local deadline=$(( $(date +%s) + timeout ))
    while [[ $(date +%s) -lt $deadline ]]; do
        if curl -sf --max-time 2 "$url" > /dev/null 2>&1; then
            log_ok "$label is ready."
            return 0
        fi
        sleep 0.5
    done
    log_err "$label did not respond within ${timeout}s."
    return 1
}

# Detect a terminal emulator for interactive use
find_terminal() {
    for t in gnome-terminal xterm konsole xfce4-terminal lxterminal; do
        if command -v "$t" &>/dev/null; then echo "$t"; return; fi
    done
    echo ""
}

open_terminal() {
    local title="$1"; shift
    local cmd="$*"
    local term
    term=$(find_terminal)
    case "$term" in
        gnome-terminal) gnome-terminal --title="$title" -- bash -c "$cmd; exec bash" ;;
        xterm)          xterm -title "$title" -e bash -c "$cmd; exec bash" ;;
        konsole)        konsole --new-tab -p tabtitle="$title" -e bash -c "$cmd; exec bash" ;;
        xfce4-terminal) xfce4-terminal --title="$title" -x bash -c "$cmd; exec bash" ;;
        lxterminal)     lxterminal --title="$title" -e bash -c "$cmd; exec bash" ;;
        *)              # headless -- run in background
                        echo ""
                        return 1
                        ;;
    esac
    return 0
}

# ---------------------------------------------------------------------------
# Validate dependencies
# ---------------------------------------------------------------------------

FUSEKI_BIN="$JENA_DIR/bin/fuseki-server"
if [[ ! -x "$FUSEKI_BIN" ]]; then
    log_err "Fuseki not found at $FUSEKI_BIN. Set --jena-dir to your Jena installation."
    exit 1
fi

for cmd in node ngrok curl; do
    if ! command -v "$cmd" &>/dev/null; then
        log_err "'$cmd' not found in PATH."
        exit 1
    fi
done

if [[ ! -d "$BRIDGE_DIR" ]]; then
    log_err "HolonBridge directory not found: $BRIDGE_DIR"
    exit 1
fi

mkdir -p "$LOG_DIR" "$JENA_DATA"

HEADLESS=false
if [[ -z "$(find_terminal)" ]]; then
    log_step "No terminal emulator found -- running headless (logs: $LOG_DIR)"
    HEADLESS=true
fi

# ---------------------------------------------------------------------------
# 1. Start Jena Fuseki
# ---------------------------------------------------------------------------

log_step "Starting Jena Fuseki..."

FUSEKI_CMD="$FUSEKI_BIN --update --loc '$JENA_DATA'"

if [[ "$HEADLESS" == true ]]; then
    eval "$FUSEKI_CMD" >> "$LOG_DIR/fuseki.log" 2>&1 &
    FUSEKI_PID=$!
    echo $FUSEKI_PID > /tmp/holonbridge-fuseki.pid
else
    open_terminal "Jena Fuseki" "$FUSEKI_CMD" || {
        eval "$FUSEKI_CMD" >> "$LOG_DIR/fuseki.log" 2>&1 &
        echo $! > /tmp/holonbridge-fuseki.pid
        HEADLESS=true
    }
fi

wait_http "http://localhost:3030/\$/ping" "Jena Fuseki" 60 || exit 1

# ---------------------------------------------------------------------------
# 2. Start ngrok
# ---------------------------------------------------------------------------

log_step "Starting ngrok tunnel..."

NGROK_CMD="ngrok http --url=$NGROK_URL 3031"

if [[ "$HEADLESS" == true ]]; then
    eval "$NGROK_CMD" >> "$LOG_DIR/ngrok.log" 2>&1 &
    echo $! > /tmp/holonbridge-ngrok.pid
else
    open_terminal "ngrok" "$NGROK_CMD" || {
        eval "$NGROK_CMD" >> "$LOG_DIR/ngrok.log" 2>&1 &
        echo $! > /tmp/holonbridge-ngrok.pid
    }
fi

wait_http "http://localhost:4040/api/tunnels" "ngrok tunnel" 20 || exit 1

# ---------------------------------------------------------------------------
# 3. Start HolonBridge
# ---------------------------------------------------------------------------

log_step "Starting HolonBridge (dataset: $DATASET)..."

BRIDGE_CMD="cd '$BRIDGE_DIR' && node server.js -d $DATASET"

if [[ "$HEADLESS" == true ]]; then
    eval "$BRIDGE_CMD" >> "$LOG_DIR/holonbridge.log" 2>&1 &
    echo $! > /tmp/holonbridge-bridge.pid
else
    open_terminal "HolonBridge" "$BRIDGE_CMD" || {
        eval "$BRIDGE_CMD" >> "$LOG_DIR/holonbridge.log" 2>&1 &
        echo $! > /tmp/holonbridge-bridge.pid
    }
fi

wait_http "http://localhost:3031/health" "HolonBridge" 20 || exit 1

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
log_ok "All services running."
echo ""
echo "  Jena Fuseki  : http://localhost:3030"
echo "  HolonBridge  : http://localhost:3031"
echo "  ngrok tunnel : https://$NGROK_URL"
echo "  Health check : http://localhost:3031/health"
if [[ "$HEADLESS" == true ]]; then
    echo ""
    echo "  Logs         : $LOG_DIR"
    echo "  PIDs         : /tmp/holonbridge-*.pid"
    echo ""
    echo "  Stop all:"
    echo "    ./stop-holonbridge.sh"
fi
echo ""
