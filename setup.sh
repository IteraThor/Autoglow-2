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

# Dynamically determine the project path
PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ ! -f "$PROJECT_DIR/server.py" ]; then
    echo "❌ ERROR: server.py not found in $PROJECT_DIR."
    exit 1
fi

if ! python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"; then
    echo "❌ ERROR: AutoGlow needs Python 3.10 or newer (found $(python3 --version 2>&1))."
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
# Google Chrome and Chromium always; Ubuntu's Chromium (snap), Brave and Edge when installed
POLICY_DIRS="/etc/opt/chrome/policies/managed /etc/chromium/policies/managed"
if command -v chromium-browser >/dev/null 2>&1 || [ -d /snap/chromium ]; then
    POLICY_DIRS="$POLICY_DIRS /etc/chromium-browser/policies/managed"
fi
if command -v brave-browser >/dev/null 2>&1 || command -v brave >/dev/null 2>&1; then
    POLICY_DIRS="$POLICY_DIRS /etc/brave/policies/managed"
fi
if command -v microsoft-edge >/dev/null 2>&1 || command -v microsoft-edge-stable >/dev/null 2>&1; then
    POLICY_DIRS="$POLICY_DIRS /etc/opt/edge/policies/managed"
fi
for POLICY_DIR in $POLICY_DIRS; do
    mkdir -p "$POLICY_DIR"
    echo "$EXT_POLICY" > "$POLICY_DIR/autoglow.json"
    chmod 644 "$POLICY_DIR/autoglow.json"
    echo "    $POLICY_DIR/autoglow.json"
done

if [ ! -d /etc/systemd/system ] || ! command -v systemctl >/dev/null 2>&1; then
    echo ""
    echo "⚠️ systemd was not found, so AutoGlow was installed but not set up as a service."
    echo "Start it manually with:"
    echo "   $PROJECT_DIR/venv/bin/python3 $PROJECT_DIR/server.py"
    exit 0
fi

# Fedora/RHEL: SELinux stops systemd from executing binaries labeled as home
# files (user_home_t), which fails with status=203/EXEC. Label the venv's
# executables as normal binaries so the service can start.
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" != "Disabled" ]; then
    echo "--> SELinux detected, labeling the virtual environment for systemd..."
    if command -v semanage >/dev/null 2>&1; then
        semanage fcontext -a -t bin_t "$PROJECT_DIR/venv/bin(/.*)?" 2>/dev/null \
            || semanage fcontext -m -t bin_t "$PROJECT_DIR/venv/bin(/.*)?" 2>/dev/null || true
        restorecon -R "$PROJECT_DIR/venv/bin" || true
    else
        chcon -R -t bin_t "$PROJECT_DIR/venv/bin" || true
    fi
fi

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
echo "on this computer (restart the browser if it is open). Then play on"
echo "https://play.autodarts.com - the extension icon shows ON when AutoGlow receives the game."

