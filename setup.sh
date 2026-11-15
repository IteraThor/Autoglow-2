#!/bin/bash
# Installs AutoGlow from this git folder as the autoglow service (via install.sh). When the folder is a release
# (after git pull of main, also in a folder that held the Python AutoGlow) it downloads that release's
# ready-built program in seconds; otherwise (development, a CPU without a ready-built release) it builds.
set -e

if [ "$EUID" -ne 0 ]; then
  echo "❌ ERROR: Please run this script with sudo:"
  echo "   sudo bash setup.sh"
  exit 1
fi
if [ -z "$SUDO_USER" ]; then
    echo "❌ ERROR: Could not determine the original user."
    exit 1
fi
ORIGINAL_USER=$SUDO_USER

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ ! -f "$PROJECT_DIR/Cargo.toml" ]; then
    echo "❌ ERROR: Cargo.toml not found in $PROJECT_DIR."
    exit 1
fi

if sudo -u "$ORIGINAL_USER" env ${AUTOGLOW_RELEASE_URL:+AUTOGLOW_RELEASE_URL="$AUTOGLOW_RELEASE_URL"} \
    bash "$PROJECT_DIR/fetch-release.sh" "$PROJECT_DIR"; then
    AUTOGLOW_DIR="$PROJECT_DIR" AUTOGLOW_FROM_SOURCE=1 exec bash "$PROJECT_DIR/install.sh"
fi

if [ -f /etc/debian_version ]; then
    apt-get update -qq && apt-get install -y -qq build-essential pkg-config curl
elif [ -f /etc/fedora-release ]; then
    dnf install -y -q gcc cargo rust
else
    echo "⚠️ WARNING: Unknown Linux distribution. Please ensure a C compiler and Rust (https://rustup.rs) are installed."
fi

# The distribution's Rust is used when it is new enough (Fedora's is); otherwise rustup installs one
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
install -o "$ORIGINAL_USER" -g "$(id -gn "$ORIGINAL_USER")" -m 755 "$PROJECT_DIR/target/release/autoglow" "$PROJECT_DIR/.autoglow.new"
mv -f "$PROJECT_DIR/.autoglow.new" "$PROJECT_DIR/autoglow"

AUTOGLOW_DIR="$PROJECT_DIR" AUTOGLOW_FROM_SOURCE=1 exec bash "$PROJECT_DIR/install.sh"
