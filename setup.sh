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
    echo "--> Installing required packages (git, build-essential, pkg-config, avahi)..."
    apt update && apt install -y git build-essential pkg-config curl avahi-daemon libnss-mdns
elif [ -f /etc/fedora-release ]; then
    echo "--> Detected Fedora system."
    echo "--> Installing required packages (git, gcc, cargo, avahi)..."
    dnf install -y git gcc cargo rust avahi nss-mdns
else
    echo "⚠️ WARNING: Unknown Linux distribution. Please ensure git, a C compiler and Rust (https://rustup.rs) are installed manually."
fi

# autoglow.local only resolves on this machine when avahi is running (nss-mdns asks it)
systemctl enable --now avahi-daemon 2>/dev/null || echo "⚠️ WARNING: Could not start avahi-daemon; http://autoglow.local:8080 may not resolve."

# Determine the original user
if [ -n "$SUDO_USER" ]; then
    ORIGINAL_USER=$SUDO_USER
else
    echo "❌ ERROR: Could not determine the original user."
    exit 1
fi

# Studio cameras (/dev/video*) and the H.264 encoder (/dev/dri/renderD*): the service runs without a
# desktop login, so it only gets these devices through the video and render groups
for GROUP in video render; do
    if getent group "$GROUP" >/dev/null 2>&1 && ! id -nG "$ORIGINAL_USER" | grep -qw "$GROUP"; then
        echo "--> Adding $ORIGINAL_USER to the $GROUP group (Studio cameras)..."
        usermod -aG "$GROUP" "$ORIGINAL_USER"
    fi
done

# Classic mode (AutoGlow 1) talks to the ESP32 over USB serial (/dev/ttyUSB*, /dev/ttyACM*)
for GROUP in dialout uucp; do
    if getent group "$GROUP" >/dev/null 2>&1 && ! id -nG "$ORIGINAL_USER" | grep -qw "$GROUP"; then
        echo "--> Adding $ORIGINAL_USER to the $GROUP group (Classic mode USB)..."
        usermod -aG "$GROUP" "$ORIGINAL_USER"
    fi
done

# Dynamically determine the project path
PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ ! -f "$PROJECT_DIR/Cargo.toml" ]; then
    echo "❌ ERROR: Cargo.toml not found in $PROJECT_DIR."
    exit 1
fi

# AutoGlow is built from source with Rust. The distribution's Rust is used when it is new enough
# (Fedora's is); otherwise rustup installs a current one for the user.
MIN_RUST="1.82"
USER_HOME=$(getent passwd "$ORIGINAL_USER" | cut -d: -f6)
CARGO="cargo"
rust_ok() {
    local v
    v=$(sudo -u "$ORIGINAL_USER" "$1" --version 2>/dev/null | awk '{print $2}') || return 1
    [ -n "$v" ] && [ "$(printf '%s\n%s\n' "$MIN_RUST" "$v" | sort -V | head -n1)" = "$MIN_RUST" ]
}
if [ -x "$USER_HOME/.cargo/bin/cargo" ] && rust_ok "$USER_HOME/.cargo/bin/cargo"; then
    CARGO="$USER_HOME/.cargo/bin/cargo"
elif ! rust_ok cargo; then
    echo "--> Installing a current Rust for $ORIGINAL_USER (rustup)..."
    sudo -u "$ORIGINAL_USER" bash -c "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal"
    CARGO="$USER_HOME/.cargo/bin/cargo"
fi

echo "--> Building AutoGlow (takes a few minutes the first time)..."
(cd "$PROJECT_DIR" && sudo -u "$ORIGINAL_USER" "$CARGO" build --release)
install -o "$ORIGINAL_USER" -g "$ORIGINAL_USER" -m 755 "$PROJECT_DIR/target/release/autoglow" "$PROJECT_DIR/autoglow"

echo "--> Installing the AutoGlow Bridge Chrome extension (Chrome/Chromium policy)..."
# The signing key is created once per installation; its ID ties the policy to the CRX AutoGlow serves
EXT_ID=$(cd "$PROJECT_DIR" && sudo -u "$ORIGINAL_USER" "$PROJECT_DIR/autoglow" id)
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
    echo "   $PROJECT_DIR/autoglow"
    exit 0
fi

# Fedora/RHEL: SELinux stops systemd from executing binaries labeled as home
# files (user_home_t), which fails with status=203/EXEC. Label the AutoGlow
# program as a normal binary so the service can start.
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" != "Disabled" ]; then
    echo "--> SELinux detected, labeling the AutoGlow program for systemd..."
    if command -v semanage >/dev/null 2>&1; then
        semanage fcontext -a -t bin_t "$PROJECT_DIR/autoglow" 2>/dev/null \
            || semanage fcontext -m -t bin_t "$PROJECT_DIR/autoglow" 2>/dev/null || true
        restorecon "$PROJECT_DIR/autoglow" || true
    else
        chcon -t bin_t "$PROJECT_DIR/autoglow" || true
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
ExecStart=$PROJECT_DIR/autoglow
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

