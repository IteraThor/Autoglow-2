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
    echo "--> Installing required packages (git, python3-venv, python3-tk, python3-dev, build-essential, pkg-config)..."
    apt update && apt install -y git python3-venv python3-tk python3-dev build-essential pkg-config
elif [ -f /etc/fedora-release ]; then
    echo "--> Detected Fedora system."
    echo "--> Installing required packages (git, python3-tkinter, python3-devel, gcc, gcc-c++, make, pkgconfig)..."
    dnf install -y git python3-tkinter python3-devel gcc gcc-c++ make pkgconfig
else
    echo "⚠️ WARNING: Unknown Linux distribution. Please ensure git, python3, venv, tkinter, gcc, and make are installed manually."
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

if [ ! -f "$PROJECT_DIR/autodarts_wled_mini.py" ]; then
    echo "❌ ERROR: autodarts_wled_mini.py not found in $PROJECT_DIR."
    exit 1
fi

echo "--> Creating a virtual Python environment..."
sudo -u "$ORIGINAL_USER" python3 -m venv "$PROJECT_DIR/venv"

echo "--> Upgrading pip and build tools..."
sudo -u "$ORIGINAL_USER" "$PROJECT_DIR/venv/bin/pip" install --upgrade pip setuptools wheel

echo "--> Installing Python packages..."
sudo -u "$ORIGINAL_USER" "$PROJECT_DIR/venv/bin/pip" install -r "$PROJECT_DIR/requirements.txt"

echo "--> Creating systemd service files..."

# Write daemon service configuration with -u flag for unbuffered logs
cat > /etc/systemd/system/autoglow.service << EOL
[Unit]
Description=AutoGlow Service for Autodarts WLED Sync
After=network.target

[Service]
User=$ORIGINAL_USER
Group=$ORIGINAL_USER
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/python3 -u $PROJECT_DIR/autodarts_wled_mini.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOL

# Write web server service configuration with -u flag for unbuffered logs
cat > /etc/systemd/system/autoglow-web.service << EOL
[Unit]
Description=AutoGlow Web Config Server
After=network.target

[Service]
User=$ORIGINAL_USER
Group=$ORIGINAL_USER
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/python3 -u $PROJECT_DIR/web_server.py --port 8080
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOL

echo "--> Activating and starting AutoGlow services..."
systemctl daemon-reload

systemctl enable autoglow.service
systemctl start autoglow.service

systemctl enable autoglow-web.service
systemctl start autoglow-web.service

echo ""
echo "✅ Setup successfully completed!"
echo "The services are now using the path: $PROJECT_DIR"
echo "  - AutoGlow Sync Service: autoglow.service"
echo "  - AutoGlow Web Configuration: autoglow-web.service (http://localhost:8080)"
echo "NOTE: If USB access fails, please log out and back in or run 'newgrp dialout'."

