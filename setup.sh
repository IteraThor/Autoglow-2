#!/bin/bash
set -e

echo "#############################################"
echo "#       AutoGlow Setup & Autostart          #"
echo "#############################################"
echo ""

# Check if script is run with sudo
if [ "$EUID" -ne 0 ]; then
  echo "❌ ERROR: Please run this script with sudo:"
  echo "   sudo bash setup.sh"
  exit 1
fi

echo "--> Checking system requirements..."

# Check and install requirements based on OS distribution
if [ -f /etc/debian_version ]; then
    echo "--> Detected Debian/Ubuntu system."
    echo "--> Installing required packages (git, python3-venv, python3-dev, build-essential)..."
    apt update && apt install -y git python3-venv python3-dev build-essential
elif [ -f /etc/fedora-release ]; then
    echo "--> Detected Fedora system."
    echo "--> Installing required packages (git, python3-devel, gcc)..."
    dnf install -y git python3-devel gcc
else
    echo "⚠️ WARNING: Unknown Linux distribution. Please ensure git, python3 and python3-venv are installed manually."
fi

# Determine the original user
if [ -n "$SUDO_USER" ]; then
    ORIGINAL_USER=$SUDO_USER
else
    echo "❌ ERROR: Could not determine the original user."
    exit 1
fi

# Assign USB permissions (dialout group)
echo "--> Granting USB permissions to user $ORIGINAL_USER..."
usermod -a -G dialout "$ORIGINAL_USER"

# Dynamically determine the project path
PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ ! -f "$PROJECT_DIR/server.py" ]; then
    echo "❌ ERROR: server.py not found in $PROJECT_DIR."
    exit 1
fi

echo "--> Creating a virtual Python environment..."
sudo -u "$ORIGINAL_USER" python3 -m venv "$PROJECT_DIR/venv"

echo "--> Upgrading pip and build tools..."
sudo -u "$ORIGINAL_USER" "$PROJECT_DIR/venv/bin/python3" -m pip install --upgrade pip setuptools wheel

echo "--> Installing Python packages..."
sudo -u "$ORIGINAL_USER" "$PROJECT_DIR/venv/bin/python3" -m pip install -r "$PROJECT_DIR/requirements.txt"

echo "--> Installing the AutoGlow Bridge Chrome extension (Chrome/Chromium policy)..."
# The signing key is created once per installation; its ID ties the policy to the CRX AutoGlow serves
EXT_ID=$(cd "$PROJECT_DIR" && sudo -u "$ORIGINAL_USER" "$PROJECT_DIR/venv/bin/python3" -m core.extension_packager id)
EXT_POLICY="{\"ExtensionInstallForcelist\": [\"$EXT_ID;http://localhost:8080/extension/update.xml\"]}"
for POLICY_DIR in /etc/opt/chrome/policies/managed /etc/chromium/policies/managed; do
    mkdir -p "$POLICY_DIR"
    echo "$EXT_POLICY" > "$POLICY_DIR/autoglow.json"
    chmod 644 "$POLICY_DIR/autoglow.json"
done

echo "--> Creating systemd service file..."

# Write unified AutoGlow 2 service configuration
cat > /etc/systemd/system/autoglow.service << EOL
[Unit]
Description=AutoGlow 2 Server & Autodarts WLED Engine
After=network.target

[Service]
User=$ORIGINAL_USER
Group=$ORIGINAL_USER
WorkingDirectory=$PROJECT_DIR
ExecStart=$PROJECT_DIR/venv/bin/python3 -u $PROJECT_DIR/server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOL

echo "--> Activating and starting AutoGlow service..."
systemctl daemon-reload

systemctl enable autoglow.service
systemctl restart autoglow.service

echo ""
echo "✅ Setup successfully completed!"
echo "AutoGlow 2 is running as a systemd service: autoglow.service"
echo "Open http://localhost:8080 or http://autoglow.local:8080 in your browser to configure."
echo ""
echo "The AutoGlow Bridge extension ($EXT_ID) installs itself in Chrome/Chromium"
echo "(restart the browser if it is open). Then play on https://play.autodarts.com -"
echo "the extension icon shows ON when AutoGlow receives the game."
echo "NOTE: If USB access fails, please log out and back in or run 'newgrp dialout'."

