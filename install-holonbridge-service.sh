#!/usr/bin/env bash
# install-holonbridge-service.sh -- Install HolonBridge as a systemd service.
#
# Usage:
#   sudo ./install-holonbridge-service.sh [OPTIONS]
#
# Options:
#   -d, --dataset DATASET    Default dataset (default: ds)
#   -j, --jena-dir DIR       Jena installation directory (default: /opt/jena)
#   -D, --jena-data DIR      Fuseki databases directory (default: /var/lib/holonbridge/databases)
#   -b, --bridge-dir DIR     HolonBridge project directory
#   -n, --ngrok-url URL      Reserved ngrok subdomain (default: kurtcagle.ngrok.io)
#   -l, --log-dir DIR        Log directory (default: /var/log/holonbridge)
#   -u, --user USER          Service user (default: holonbridge)
#   --uninstall              Remove the services
#   -h, --help               Show this help
#
# Creates three separate systemd units so each service can be monitored,
# restarted, and logged independently:
#
#   jena-fuseki.service      -- Jena Fuseki triplestore
#   ngrok-holonbridge.service -- ngrok tunnel (depends on jena-fuseki)
#   holonbridge.service      -- HolonBridge bridge (depends on ngrok)
#
# After install:
#   systemctl start holonbridge    (starts all three via dependencies)
#   systemctl stop  holonbridge
#   journalctl -u holonbridge -f   (follow logs)
#   journalctl -u jena-fuseki -f

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
SERVICE_USER="holonbridge"
UNINSTALL=false

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

usage() {
    grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -30
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -d|--dataset)    DATASET="$2";      shift 2 ;;
        -j|--jena-dir)   JENA_DIR="$2";     shift 2 ;;
        -D|--jena-data)  JENA_DATA="$2";    shift 2 ;;
        -b|--bridge-dir) BRIDGE_DIR="$2";   shift 2 ;;
        -n|--ngrok-url)  NGROK_URL="$2";    shift 2 ;;
        -l|--log-dir)    LOG_DIR="$2";      shift 2 ;;
        -u|--user)       SERVICE_USER="$2"; shift 2 ;;
        --uninstall)     UNINSTALL=true;    shift ;;
        -h|--help)       usage ;;
        *) echo "Unknown option: $1"; usage ;;
    esac
done

# ---------------------------------------------------------------------------
# Must run as root
# ---------------------------------------------------------------------------

if [[ $EUID -ne 0 ]]; then
    echo "This script must be run as root (sudo)." >&2
    exit 1
fi

if ! command -v systemctl &>/dev/null; then
    echo "systemd not found. This installer requires a systemd-based Linux distro." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Uninstall path
# ---------------------------------------------------------------------------

if [[ "$UNINSTALL" == true ]]; then
    echo "Stopping and removing HolonBridge services..."
    systemctl stop  holonbridge.service      2>/dev/null || true
    systemctl stop  ngrok-holonbridge.service 2>/dev/null || true
    systemctl stop  jena-fuseki.service       2>/dev/null || true
    systemctl disable holonbridge.service       2>/dev/null || true
    systemctl disable ngrok-holonbridge.service 2>/dev/null || true
    systemctl disable jena-fuseki.service       2>/dev/null || true
    rm -f /etc/systemd/system/holonbridge.service
    rm -f /etc/systemd/system/ngrok-holonbridge.service
    rm -f /etc/systemd/system/jena-fuseki.service
    systemctl daemon-reload
    echo "Done. Service files removed."
    exit 0
fi

# ---------------------------------------------------------------------------
# Create service user if needed
# ---------------------------------------------------------------------------

if ! id "$SERVICE_USER" &>/dev/null; then
    echo "Creating service user '$SERVICE_USER'..."
    useradd --system --shell /usr/sbin/nologin --create-home \
            --home-dir /var/lib/holonbridge "$SERVICE_USER"
fi

# ---------------------------------------------------------------------------
# Create directories
# ---------------------------------------------------------------------------

for dir in "$LOG_DIR" "$JENA_DATA"; do
    mkdir -p "$dir"
    chown "$SERVICE_USER:$SERVICE_USER" "$dir"
done

# ---------------------------------------------------------------------------
# Write environment file
# ---------------------------------------------------------------------------

ENV_FILE="/etc/holonbridge/holonbridge.env"
mkdir -p /etc/holonbridge

if [[ ! -f "$ENV_FILE" ]]; then
    cat > "$ENV_FILE" << EOF
# HolonBridge environment configuration
# Edit these values, then: sudo systemctl restart holonbridge

JENA_DIR=$JENA_DIR
JENA_DATA=$JENA_DATA
BRIDGE_DIR=$BRIDGE_DIR
NGROK_URL=$NGROK_URL
DATASET=$DATASET
LOG_DIR=$LOG_DIR

# Anthropic API key (required for NL query)
ANTHROPIC_API_KEY=your-key-here

# HolonBridge settings
JENA_BASE=http://localhost:3030
JENA_DATASET=$DATASET
PORT=3031
MAX_RETRIES=2
CLAUDE_MODEL=claude-sonnet-4-6
SHACL_REQUIRED=true
LOG_SPARQL=false
LOG_PROMPTS=false
EOF
    chown root:$SERVICE_USER "$ENV_FILE"
    chmod 640 "$ENV_FILE"
    echo "Environment file written: $ENV_FILE"
    echo "IMPORTANT: Edit $ENV_FILE and set ANTHROPIC_API_KEY before starting."
fi

# ---------------------------------------------------------------------------
# 1. jena-fuseki.service
# ---------------------------------------------------------------------------

cat > /etc/systemd/system/jena-fuseki.service << EOF
[Unit]
Description=Jena Fuseki Triplestore
After=network.target
Wants=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=$ENV_FILE
ExecStart=$JENA_DIR/bin/fuseki-server --update --loc \${JENA_DATA}
WorkingDirectory=$JENA_DATA
StandardOutput=journal
StandardError=journal
SyslogIdentifier=jena-fuseki
Restart=on-failure
RestartSec=5s

# Give Fuseki time to initialise before dependents start
ExecStartPost=/bin/bash -c '\
  for i in \$(seq 1 30); do \
    curl -sf http://localhost:3030/\$/ping > /dev/null 2>&1 && exit 0; \
    sleep 1; \
  done; exit 1'

[Install]
WantedBy=multi-user.target
EOF

echo "Written: /etc/systemd/system/jena-fuseki.service"

# ---------------------------------------------------------------------------
# 2. ngrok-holonbridge.service
# ---------------------------------------------------------------------------

cat > /etc/systemd/system/ngrok-holonbridge.service << EOF
[Unit]
Description=ngrok Tunnel for HolonBridge
After=network.target jena-fuseki.service
Requires=jena-fuseki.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v ngrok) http --url=\${NGROK_URL} 3031
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ngrok-holonbridge
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

echo "Written: /etc/systemd/system/ngrok-holonbridge.service"

# ---------------------------------------------------------------------------
# 3. holonbridge.service
# ---------------------------------------------------------------------------

NODE_BIN=$(command -v node)

cat > /etc/systemd/system/holonbridge.service << EOF
[Unit]
Description=HolonBridge RDF Bridge
After=network.target jena-fuseki.service ngrok-holonbridge.service
Requires=jena-fuseki.service ngrok-holonbridge.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$BRIDGE_DIR
ExecStart=$NODE_BIN server.js -d \${DATASET}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=holonbridge
Restart=on-failure
RestartSec=5s

# Resource limits
LimitNOFILE=65536
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

echo "Written: /etc/systemd/system/holonbridge.service"

# ---------------------------------------------------------------------------
# Enable and start
# ---------------------------------------------------------------------------

systemctl daemon-reload
systemctl enable jena-fuseki.service ngrok-holonbridge.service holonbridge.service

echo ""
echo "Services enabled. To start:"
echo "  sudo systemctl start holonbridge"
echo ""
echo "This starts all three in dependency order."
echo ""
echo "Useful commands:"
echo "  sudo systemctl status  holonbridge"
echo "  sudo systemctl stop    holonbridge"
echo "  sudo systemctl restart holonbridge"
echo "  sudo journalctl -u holonbridge         -f   (bridge logs)"
echo "  sudo journalctl -u jena-fuseki         -f   (Jena logs)"
echo "  sudo journalctl -u ngrok-holonbridge   -f   (ngrok logs)"
echo ""
echo "Config: $ENV_FILE"
echo "  --> Edit ANTHROPIC_API_KEY before starting."
echo ""
echo "To uninstall:"
echo "  sudo ./install-holonbridge-service.sh --uninstall"
echo ""
