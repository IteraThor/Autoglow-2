#!/bin/bash
# AutoGlow 2 install and update for Linux (x86_64 and 64-bit ARM, e.g. Raspberry Pi). Run as your normal user:
#
#   curl -fsSL https://github.com/IteraThor/Autoglow-2/releases/latest/download/install.sh | bash
#
# Downloads the ready-built program from the latest GitHub release (nothing is compiled), puts it in
# ~/autoglow and runs it as the autoglow systemd service (asks for your sudo password). Update with
# `bash ~/autoglow/install.sh`; settings, flows, profiles and Studio data are kept.
#
#   AUTOGLOW_DIR=/path      install folder (default: the folder of an existing install, else ~/autoglow)
#   AUTOGLOW_VERSION=v0.32.0  a specific release instead of the latest
#   AUTOGLOW_URL=...        the release archive to install, run as root (e.g. file:// of a test build)
#   AUTOGLOW_FROM_SOURCE=1  used by setup.sh: the program is already built in AUTOGLOW_DIR
set -euo pipefail

# Braces around the whole script: bash reads it to the end before running anything, so a cut-off download
# never runs half an install and commands below cannot read the rest of a piped script as their input
{
REPO="IteraThor/Autoglow-2"
SERVICE=/etc/systemd/system/autoglow.service

release_arch() {
    case "$(uname -m)" in
        x86_64 | amd64) echo x86_64 ;;
        aarch64 | arm64) echo aarch64 ;;
        *)
            echo "❌ There is no ready-built AutoGlow for $(uname -m). Build it from source instead:" >&2
            echo "   git clone https://github.com/$REPO.git && cd Autoglow-2 && sudo bash setup.sh" >&2
            return 1 ;;
    esac
}

# The release archive for a CPU: the release AUTOGLOW_VERSION, else the latest one
release_url() {
    if [ -n "${AUTOGLOW_VERSION:-}" ]; then
        echo "https://github.com/$REPO/releases/download/$AUTOGLOW_VERSION/autoglow-linux-$1.tar.gz"
    else
        echo "https://github.com/$REPO/releases/latest/download/autoglow-linux-$1.tar.gz"
    fi
}

# Run as the user: download the release, then install it as root with the installer from that same release
if [ "$EUID" -ne 0 ]; then
    ARCH=$(release_arch)
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT
    echo "--> Downloading AutoGlow ($ARCH)..."
    if ! curl -fsSL --retry 2 -o "$TMP/autoglow-linux-$ARCH.tar.gz" "$(release_url "$ARCH")"; then
        echo "❌ Download failed. Check the internet connection and try again."
        exit 1
    fi
    tar -xzf "$TMP/autoglow-linux-$ARCH.tar.gz" -C "$TMP" ./install.sh
    sudo env AUTOGLOW_URL="file://$TMP/autoglow-linux-$ARCH.tar.gz" ${AUTOGLOW_DIR:+AUTOGLOW_DIR="$AUTOGLOW_DIR"} \
        bash "$TMP/install.sh"
    exit 0
fi

# AutoGlow runs as the user who called sudo, not as root
RUN_USER="${AUTOGLOW_USER:-${SUDO_USER:-}}"
if [ -z "$RUN_USER" ] || [ "$RUN_USER" = "root" ]; then
    echo "❌ Run the installer as your normal user, not as root (or set AUTOGLOW_USER)."
    exit 1
fi
RUN_GROUP=$(id -gn "$RUN_USER")
USER_HOME=$(getent passwd "$RUN_USER" | cut -d: -f6)

# An earlier install keeps its folder, unless it is a source folder (git clone or ZIP, also of the Python
# versions): those are left untouched and their settings are copied to the new folder below
is_source() { [ -e "$1/.git" ] || [ -f "$1/Cargo.toml" ] || [ -f "$1/server.py" ]; }
OLD_DIR=""
if [ -f "$SERVICE" ]; then
    OLD_DIR=$(sed -n 's/^WorkingDirectory=//p' "$SERVICE" | head -n1)
    [ -d "$OLD_DIR" ] || OLD_DIR=""
fi
if [ -z "${AUTOGLOW_DIR:-}" ]; then
    if [ -n "$OLD_DIR" ] && ! is_source "$OLD_DIR"; then
        AUTOGLOW_DIR="$OLD_DIR"
    else
        AUTOGLOW_DIR="$USER_HOME/autoglow"
    fi
fi
DIR="$AUTOGLOW_DIR"
FROM_SOURCE="${AUTOGLOW_FROM_SOURCE:-}"
if [ -z "$FROM_SOURCE" ] && is_source "$DIR"; then
    echo "❌ $DIR holds the AutoGlow source code. Update it with: git pull && sudo bash setup.sh"
    echo "   or install to another folder: curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | AUTOGLOW_DIR=/other/folder bash"
    exit 1
fi

# autoglow.local only resolves when avahi runs (nss-mdns asks it); skipped when already installed
if ! command -v avahi-daemon >/dev/null 2>&1 && [ ! -x /usr/sbin/avahi-daemon ] || ! ldconfig -p | grep libnss_mdns >/dev/null; then
    echo "--> Installing avahi (http://autoglow.local:8080)..."
    if command -v apt-get >/dev/null 2>&1; then
        apt-get install -y -qq avahi-daemon libnss-mdns >/dev/null || { apt-get update -qq && apt-get install -y -qq avahi-daemon libnss-mdns >/dev/null; }
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y -q avahi nss-mdns >/dev/null
    else
        echo "⚠️  Install avahi and nss-mdns yourself for http://autoglow.local:8080."
    fi
fi
systemctl enable --now avahi-daemon >/dev/null 2>&1 || true

OLD_VERSION=""
[ -x "$DIR/autoglow" ] && OLD_VERSION=$("$DIR/autoglow" version 2>/dev/null || true)

if [ -z "$FROM_SOURCE" ]; then
    ARCH=$(release_arch)
    URL="${AUTOGLOW_URL:-$(release_url "$ARCH")}"
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT
    case "$URL" in file://*) ;; *) echo "--> Downloading AutoGlow ($ARCH)..." ;; esac
    if ! curl -fsSL "$URL" | tar -xz -C "$TMP"; then
        echo "❌ Download failed. Check the internet connection and try again."
        exit 1
    fi

    install -d -o "$RUN_USER" -g "$RUN_GROUP" "$DIR"
    # Shipped folders are replaced whole; user data (config.json, flows, presets, Studio, club, ...) lives
    # next to them and is never touched
    for d in web defaults chrome_extension; do
        rm -rf "${DIR:?}/$d"
        cp -r "$TMP/$d" "$DIR/$d"
        chown -R "$RUN_USER:$RUN_GROUP" "$DIR/$d"
    done
    for f in README.md install.sh; do
        install -o "$RUN_USER" -g "$RUN_GROUP" -m 644 "$TMP/$f" "$DIR/$f"
    done
    # Renamed into place, so a running AutoGlow keeps its program until the restart below
    install -o "$RUN_USER" -g "$RUN_GROUP" -m 755 "$TMP/autoglow" "$DIR/.autoglow.new"
    mv -f "$DIR/.autoglow.new" "$DIR/autoglow"

    # Coming from a source folder: copy its settings and data once. The old folder is left as it was.
    if [ -n "$OLD_DIR" ] && [ "$OLD_DIR" != "$DIR" ] && is_source "$OLD_DIR"; then
        echo "--> Copying settings from $OLD_DIR..."
        for p in "$OLD_DIR"/* "$OLD_DIR"/.sync_status.json; do
            [ -e "$p" ] || continue
            case "$(basename "$p")" in
                src | web | defaults | chrome_extension | tests | target | core | routes | venv | docs | \
                Cargo.toml | Cargo.lock | README.md | *.sh | *.bat | *.py | requirements*.txt | \
                autoglow | autoglow.exe | *.log | *.log.*) continue ;;
            esac
            [ -e "$DIR/$(basename "$p")" ] || cp -a "$p" "$DIR/"
        done
        chown -R "$RUN_USER:$RUN_GROUP" "$DIR"
    fi
fi

# Studio cameras (/dev/video*), the H.264 encoder (/dev/dri/renderD*) and Classic mode's USB ESP32
# (/dev/ttyUSB*, /dev/ttyACM*): the service runs without a desktop login, so it needs these groups
for GROUP in video render dialout uucp; do
    if getent group "$GROUP" >/dev/null 2>&1 && ! id -nG "$RUN_USER" | grep -qw "$GROUP"; then
        usermod -aG "$GROUP" "$RUN_USER"
    fi
done

echo "--> Installing the AutoGlow Bridge Chrome extension (browser policy)..."
# The signing key is created once per installation; its ID ties the policy to the CRX AutoGlow serves
EXT_ID=$(sudo -u "$RUN_USER" "$DIR/autoglow" id)
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
done

if [ ! -d /etc/systemd/system ] || ! command -v systemctl >/dev/null 2>&1; then
    echo ""
    echo "⚠️  systemd was not found, so AutoGlow is installed but not set up as a service."
    echo "   Start it with: $DIR/autoglow"
    exit 0
fi

# Fedora/RHEL: SELinux stops systemd from running programs labeled as home files (status=203/EXEC)
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" != "Disabled" ]; then
    if command -v semanage >/dev/null 2>&1; then
        semanage fcontext -a -t bin_t "$DIR/autoglow" 2>/dev/null \
            || semanage fcontext -m -t bin_t "$DIR/autoglow" 2>/dev/null || true
        restorecon "$DIR/autoglow" || true
    else
        chcon -t bin_t "$DIR/autoglow" || true
    fi
fi

cat > "$SERVICE" << EOL
[Unit]
Description=AutoGlow 2 Server & Autodarts WLED Engine
After=network.target

[Service]
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$DIR
ExecStart=$DIR/autoglow
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOL

echo "--> Starting AutoGlow..."
systemctl daemon-reload
systemctl enable autoglow.service >/dev/null 2>&1
systemctl restart autoglow.service
for _ in $(seq 1 20); do
    curl -fs -o /dev/null http://localhost:8080/ && break
    sleep 0.5
done

NEW_VERSION=$("$DIR/autoglow" version 2>/dev/null || true)
echo ""
if [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$NEW_VERSION" ]; then
    echo "✅ Updated: $OLD_VERSION → $NEW_VERSION"
else
    echo "✅ $NEW_VERSION is installed and running."
fi
echo "   Open http://localhost:8080 (or http://autoglow.local:8080)."
if [ -z "$OLD_VERSION" ]; then
    echo "   The AutoGlow Bridge extension installs itself in Chrome/Chromium on this computer"
    echo "   (restart the browser if it is open). Then play on https://play.autodarts.com."
fi
if [ -n "$FROM_SOURCE" ]; then
    echo "   Update later with: git pull && sudo bash setup.sh. Folder: $DIR"
else
    echo "   Update later with: bash $DIR/install.sh"
fi
exit 0
}
