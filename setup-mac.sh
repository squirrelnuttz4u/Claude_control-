#!/bin/bash
# ─────────────────────────────────────────────────────
# Claude Control - macOS Network Setup
# Run this once to allow phone connections through the firewall
# Usage: sudo bash setup-mac.sh
# ─────────────────────────────────────────────────────

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Claude Control - macOS Network Setup        ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}This script needs sudo to modify firewall settings.${NC}"
  echo ""
  echo "Run:  sudo bash setup-mac.sh"
  echo ""
  exit 1
fi

# Find node binary
NODE_BIN=$(which node 2>/dev/null || echo "")
if [ -z "$NODE_BIN" ]; then
  # Try common locations
  for p in /usr/local/bin/node /opt/homebrew/bin/node ~/.nvm/versions/node/*/bin/node; do
    if [ -f "$p" ]; then
      NODE_BIN="$p"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo -e "${RED}Could not find Node.js binary.${NC}"
  echo "Install Node.js first: https://nodejs.org"
  exit 1
fi

echo -e "Node.js found: ${GREEN}$NODE_BIN${NC}"
echo ""

# Check firewall state
FW_STATE=$(/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>&1)
echo "Firewall status: $FW_STATE"
echo ""

if echo "$FW_STATE" | grep -q "disabled"; then
  echo -e "${GREEN}Firewall is disabled - no changes needed.${NC}"
  echo "Your phone should be able to connect already."
else
  echo "Configuring firewall to allow Node.js connections..."
  echo ""

  # Add node to firewall exceptions
  /usr/libexec/ApplicationFirewall/socketfilterfw --add "$NODE_BIN" 2>/dev/null || true
  /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$NODE_BIN" 2>/dev/null || true

  echo -e "${GREEN}Done! Node.js has been added to firewall exceptions.${NC}"
  echo ""

  # Verify
  echo "Verifying..."
  APP_STATE=$(/usr/libexec/ApplicationFirewall/socketfilterfw --listapps 2>&1 | grep -i node || echo "")
  if [ -n "$APP_STATE" ]; then
    echo -e "${GREEN}$APP_STATE${NC}"
  fi
fi

echo ""
echo "─────────────────────────────────────────────────"
echo ""
echo "Next steps:"
echo "  1. Make sure your Mac and phone are on the same Wi-Fi"
echo "  2. Start the dashboard:  npm start"
echo "  3. Open the Network URL on your phone's browser"
echo ""

# Get IP
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "?.?.?.?")
echo -e "  Your Mac's IP: ${GREEN}$IP${NC}"
echo ""
