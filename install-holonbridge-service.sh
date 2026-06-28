#!/usr/bin/env bash
# install-holonbridge-service.sh -- Install HolonBridge as systemd services.
#
# Usage:
#   sudo ./install-holonbridge-service.sh [OPTIONS]
#
# Options:
#   -d, --dataset DATASET    Default dataset (default: ds)
#   -j, --jena-dir DIR       Jena installation directory (default: /opt/jena)
#   -D, --jena-data DIR      Fuseki databases directory (default: /var/lib/holonbridge/databases)
#   -b, --bridge-dir DIR     holon-bridge repo root (default: /opt/holonbridge/holon-bridge)
#   -n, --ngrok-url URL      Reserved ngrok subdomain for HolonBridge REST :3031
#   -m, --mcp-ngrok-url URL  Reserved ngrok subdomain for MCP remote :3032
#   -u, --user USER          Service user (default: holonbridge)
#   -l, --log-dir DIR        Log directory (default: /var/log/holonbridge)
#   --skip-ngrok             Omit ngrok service units (use when reverse-proxied)
#   --uninstall              Remove all services
#   -h, --help               Show this help
#
# Creates five systemd units (or three with --skip-ngrok):
#
#   jena-fuseki.service            Jena Fuseki triplestore (:3030)
#   ngrok-holonbridge.service      ngrok tunnel → HolonBridge REST (:3031)  [skippable]
#   holonbridge.service            HolonBridge REST API (:3031)
#   ngrok-holonbridge-mcp.service  ngrok tunnel → MCP remote (:3032)        [skippable]
#   holonbridge-mcp-remote.service MCP remote SSE server (:3032)
#
# Start everything:
#   sudo systemctl start holonbridge-mcp-remote   # starts all via dependencies
#
# After install, edit /etc/holonbridge/holonbridge.env before starting.

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────

DATASET="ds"
JENA_DIR="/opt/jena"
JENA_DATA="/var/lib/holonbridge/databases"
BRIDGE_DIR="/opt/holonbridge/holon-bridge"
NGROK_URL="yourServer.ngrok.io"
MCP_NGROK_URL="yourServer-mcp.ngrok.io"
SERVICE_USER="holonbridge"
LOG_DIR="/var/log/holonbridge"
SKIP_NGROK=false
UNINSTALL=false

# ── Argument parsing ──────────────────────────────────────────────────────────

usage() { grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -35; exit 0; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        -d|--dataset)       DATASET="$2";       shift 2 ;;
        -j|--jena-dir)      JENA_DIR="$2";      shift 2 ;;
        -D|--jena-data)     JENA_DATA="$2";     shift 2 ;;
        -b|--bridge-dir)    BRIDGE_DIR="$2";    shift 2 ;;
        -n|--ngrok-url)     NGROK_URL="$2";     shift 2 ;;
        -m|--mcp-ngrok-url) MCP_NGROK_URL="$2"; shift 2 ;;
        -u|--user)          SERVICE_USER="$2";  shift 2 ;;
        -l|--log-dir)       LOG_DIR="$2";       shift 2 ;;
        --skip-ngrok)       SKIP_NGROK=true;    shift ;;
        --uninstall)        UNINSTALL=true;     shift ;;
        -h|--help)          usage ;;
        *) echo "Unknown option: $1"; usage ;;
    esac
done

[[ $EUID -ne 0 ]] && { echo "Run as root (sudo)." >&2; exit 1; }
command -v systemctl &>/dev/null || { echo "systemd required." >&2; exit 1; }

MCP_DIR="$BRIDGE_DIR/mcp-remote"

# ── Uninstall ─────────────────────────────────────────────────────────────────

if [[ "$UNINSTALL" == true ]]; then
    echo "Stopping and removing HolonBridge services..."
    for svc in holonbridge-mcp-remote holonbridge ngrok-holonbridge-mcp \
                ngrok-holonbridge jena-fuseki; do
        systemctl stop    "$svc.service" 2>/dev/null || true
        systemctl disable "$svc.service" 2>/dev/null || true
        rm -f "/etc/systemd/system/$svc.service"
    done
    systemctl daemon-reload
    echo "Done."
    exit 0
fi

# ── Service user ──────────────────────────────────────────────────────────────

if ! id "$SERVICE_USER" &>/dev/null; then
    echo "Creating service user '$SERVICE_USER'..."
    useradd --system --shell /usr/sbin/nologin --create-home \
            --home-dir /var/lib/holonbridge "$SERVICE_USER"
fi

# ── Directories ───────────────────────────────────────────────────────────────

for dir in "$LOG_DIR" "$JENA_DATA"; do
    mkdir -p "$dir"
    chown "$SERVICE_USER:$SERVICE_USER" "$dir"
done

# ── Environment file ──────────────────────────────────────────────────────────

mkdir -p /etc/holonbridge
ENV_FILE="/etc/holonbridge/holonbridge.env"

if [[ ! -f "$ENV_FILE" ]]; then
    cat > "$ENV_FILE" << EOF
# HolonBridge environment -- edit before starting services
# Shared by all HolonBridge systemd units.

JENA_DIR=$JENA_DIR
JENA_DATA=$JENA_DATA
BRIDGE_DIR=$BRIDGE_DIR
MCP_DIR=$MCP_DIR
DATASET=$DATASET

# Anthropic API key (required for nl_query)
ANTHROPIC_API_KEY=your-anthropic-api-key

# HolonBridge REST settings (port 3031)
FUSEKI_URL=http://localhost:3030
FUSEKI_DATASET=$DATASET
PORT=3031
SHACL_REQUIRED=false
LOG_SPARQL=false

# Bearer token for HolonBridge REST (generate: openssl rand -hex 32)
BEARER_TOKEN=your-holonbridge-bearer-token

# MCP remote settings (port 3032)
# HOLONBRIDGE_URL must be the PUBLIC URL of HolonBridge REST.
# If using ngrok: https://$NGROK_URL
# If directly hosted: https://yourServer.example.com
HOLONBRIDGE_URL=https://$NGROK_URL
HB_BEARER_TOKEN=your-holonbridge-bearer-token
MCP_REMOTE_TOKEN=your-mcp-remote-token
MCP_PORT=3032
MCP_PUBLIC_URL=https://$MCP_NGROK_URL
FUSEKI_GSP=http://localhost:3030/\${DATASET}/data
EOF
    chown root:"$SERVICE_USER" "$ENV_FILE"
    chmod 640 "$ENV_FILE"
    echo "Environment file written: $ENV_FILE"
    echo "IMPORTANT: Edit $ENV_FILE and set your tokens before starting."
fi

# ── locate node and ngrok ─────────────────────────────────────────────────────

NODE_BIN=$(command -v node 2>/dev/null || true)
[[ -z "$NODE_BIN" ]] && { echo "node not found. Install Node.js >= 18." >&2; exit 1; }

FUSEKI_BIN="$JENA_DIR/bin/fuseki-server"
[[ ! -x "$FUSEKI_BIN" ]] && FUSEKI_BIN=$(command -v fuseki-server 2>/dev/null || true)
[[ -z "$FUSEKI_BIN" || ! -x "$FUSEKI_BIN" ]] && {
    echo "fuseki-server not found. Set --jena-dir or install Jena." >&2; exit 1
}

if [[ "$SKIP_NGROK" == false ]]; then
    NGROK_BIN=$(command -v ngrok 2>/dev/null || true)
    [[ -z "$NGROK_BIN" ]] && { echo "ngrok not found. Install from https://ngrok.com or use --skip-ngrok." >&2; exit 1; }
fi

# ── 1. jena-fuseki.service ────────────────────────────────────────────────────

cat > /etc/systemd/system/jena-fuseki.service << EOF
[Unit]
Description=Jena Fuseki Triplestore (:3030)
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=$ENV_FILE
ExecStart=$FUSEKI_BIN --update --loc \${JENA_DATA}
WorkingDirectory=$JENA_DATA
StandardOutput=journal
StandardError=journal
SyslogIdentifier=jena-fuseki
Restart=on-failure
RestartSec=5s
ExecStartPost=/bin/bash -c 'for i in \$(seq 1 30); do \
  curl -sf http://localhost:3030/\$/ping >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'

[Install]
WantedBy=multi-user.target
EOF
echo "Written: jena-fuseki.service"

# ── 2. ngrok-holonbridge.service (optional) ───────────────────────────────────

if [[ "$SKIP_NGROK" == false ]]; then
cat > /etc/systemd/system/ngrok-holonbridge.service << EOF
[Unit]
Description=ngrok tunnel — HolonBridge REST (:3031 → $NGROK_URL)
After=network.target jena-fuseki.service
Requires=jena-fuseki.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=$ENV_FILE
ExecStart=$NGROK_BIN http --url=$NGROK_URL 3031
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ngrok-holonbridge
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF
echo "Written: ngrok-holonbridge.service"
fi

# ── 3. holonbridge.service ────────────────────────────────────────────────────

BRIDGE_AFTER="jena-fuseki.service"
BRIDGE_REQUIRES="jena-fuseki.service"
[[ "$SKIP_NGROK" == false ]] && {
    BRIDGE_AFTER="$BRIDGE_AFTER ngrok-holonbridge.service"
    BRIDGE_REQUIRES="$BRIDGE_REQUIRES ngrok-holonbridge.service"
}

cat > /etc/systemd/system/holonbridge.service << EOF
[Unit]
Description=HolonBridge REST API (:3031)
After=network.target $BRIDGE_AFTER
Requires=$BRIDGE_REQUIRES

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$BRIDGE_DIR
ExecStart=$NODE_BIN server.js
StandardOutput=journal
StandardError=journal
SyslogIdentifier=holonbridge
Restart=on-failure
RestartSec=5s
LimitNOFILE=65536
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
echo "Written: holonbridge.service"

# ── 4. ngrok-holonbridge-mcp.service (optional) ───────────────────────────────

if [[ "$SKIP_NGROK" == false ]]; then
cat > /etc/systemd/system/ngrok-holonbridge-mcp.service << EOF
[Unit]
Description=ngrok tunnel — HolonBridge MCP remote (:3032 → $MCP_NGROK_URL)
After=network.target holonbridge.service
Requires=holonbridge.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=$ENV_FILE
ExecStart=$NGROK_BIN http --url=$MCP_NGROK_URL 3032
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ngrok-holonbridge-mcp
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF
echo "Written: ngrok-holonbridge-mcp.service"
fi

# ── 5. holonbridge-mcp-remote.service ────────────────────────────────────────

MCP_AFTER="holonbridge.service"
MCP_REQUIRES="holonbridge.service"
[[ "$SKIP_NGROK" == false ]] && {
    MCP_AFTER="$MCP_AFTER ngrok-holonbridge-mcp.service"
    MCP_REQUIRES="$MCP_REQUIRES ngrok-holonbridge-mcp.service"
}

cat > /etc/systemd/system/holonbridge-mcp-remote.service << EOF
[Unit]
Description=HolonBridge MCP Remote SSE Server (:3032)
After=network.target $MCP_AFTER
Requires=$MCP_REQUIRES

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$MCP_DIR
ExecStart=$NODE_BIN holonbridge-mcp-remote.js
StandardOutput=journal
StandardError=journal
SyslogIdentifier=holonbridge-mcp-remote
Restart=on-failure
RestartSec=5s
LimitNOFILE=65536
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
echo "Written: holonbridge-mcp-remote.service"

# ── Enable all services ───────────────────────────────────────────────────────

systemctl daemon-reload

UNITS="jena-fuseki holonbridge holonbridge-mcp-remote"
[[ "$SKIP_NGROK" == false ]] && UNITS="jena-fuseki ngrok-holonbridge holonbridge ngrok-holonbridge-mcp holonbridge-mcp-remote"

# shellcheck disable=SC2086
systemctl enable $UNITS

echo ""
echo "Services enabled. To start the full stack:"
echo "  sudo systemctl start holonbridge-mcp-remote"
echo "  (systemd starts all dependencies in order)"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status  holonbridge-mcp-remote"
echo "  sudo systemctl stop    holonbridge-mcp-remote"
echo "  sudo systemctl restart holonbridge-mcp-remote"
echo "  sudo journalctl -u holonbridge              -f"
echo "  sudo journalctl -u holonbridge-mcp-remote   -f"
echo "  sudo journalctl -u jena-fuseki              -f"
[[ "$SKIP_NGROK" == false ]] && echo "  sudo journalctl -u ngrok-holonbridge        -f"
[[ "$SKIP_NGROK" == false ]] && echo "  sudo journalctl -u ngrok-holonbridge-mcp   -f"
echo ""
echo "Config: $ENV_FILE"
echo "  --> Set BEARER_TOKEN, MCP_REMOTE_TOKEN, ANTHROPIC_API_KEY before starting."
echo ""
echo "To uninstall:"
echo "  sudo ./install-holonbridge-service.sh --uninstall"
echo ""
