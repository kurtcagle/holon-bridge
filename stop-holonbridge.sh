#!/usr/bin/env bash
# stop-holonbridge.sh -- Stop all HolonBridge services started by start-holonbridge.sh
#
# Usage:
#   ./stop-holonbridge.sh

set -euo pipefail

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

log_step() { echo -e "${CYAN}[$(date '+%H:%M:%S')] $*${NC}"; }
log_ok()   { echo -e "${GREEN}[$(date '+%H:%M:%S')] OK  $*${NC}"; }
log_err()  { echo -e "${RED}[$(date '+%H:%M:%S')] ERR $*${NC}" >&2; }

stop_pid() {
    local label="$1"
    local pidfile="$2"
    if [[ -f "$pidfile" ]]; then
        local pid
        pid=$(cat "$pidfile")
        if kill -0 "$pid" 2>/dev/null; then
            log_step "Stopping $label (PID $pid)..."
            kill "$pid" && log_ok "$label stopped." || log_err "Could not stop $label."
        else
            log_step "$label (PID $pid) is not running."
        fi
        rm -f "$pidfile"
    else
        log_step "No PID file for $label -- may already be stopped."
    fi
}

stop_pid "HolonBridge" /tmp/holonbridge-bridge.pid
stop_pid "ngrok"       /tmp/holonbridge-ngrok.pid
stop_pid "Jena Fuseki" /tmp/holonbridge-fuseki.pid

echo ""
log_ok "All services stopped."
echo ""
