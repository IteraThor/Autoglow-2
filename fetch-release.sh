#!/bin/bash
# Puts the ready-built program of this checkout's release into ./autoglow, so a git install (also one that
# started as the Python AutoGlow and was updated with git pull) updates in seconds instead of compiling.
# Only when the checkout is exactly a release: the tag v<version> on origin points at HEAD and the source is
# unchanged. Exits 1 otherwise; setup.sh and server.py then build. Runs as the folder's owner, no root needed.
#
#   fetch-release.sh [DIR]          DIR defaults to the folder of this script
#   AUTOGLOW_RELEASE_URL=...        base URL of the release downloads instead of GitHub (tests)
set -euo pipefail

DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$DIR"

case "$(uname -m)" in
    x86_64 | amd64) ARCH=x86_64 ;;
    aarch64 | arm64) ARCH=aarch64 ;;
    *) echo "  - There is no ready-built AutoGlow for $(uname -m): building instead."; exit 1 ;;
esac
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n1)
HEAD=$(git rev-parse HEAD 2>/dev/null) || { echo "  - Not a git checkout: building instead."; exit 1; }
if ! git diff --quiet HEAD -- src Cargo.toml Cargo.lock; then
    echo "  - The source has local changes: building instead."
    exit 1
fi
# The commit of tag v<version> (the peeled ^{} line of an annotated tag wins over the tag object)
TAGGED=$(git ls-remote origin "refs/tags/v$VERSION" "refs/tags/v$VERSION^{}" 2>/dev/null | sort -k2 | awk 'END { print $1 }')
if [ "$TAGGED" != "$HEAD" ]; then
    echo "  - This checkout is not the release v$VERSION: building instead."
    exit 1
fi

BASE="${AUTOGLOW_RELEASE_URL:-https://github.com/IteraThor/Autoglow-2/releases/download}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "--> Downloading the ready-built AutoGlow v$VERSION ($ARCH)..."
if ! curl -fsSL --retry 2 --connect-timeout 10 "$BASE/v$VERSION/autoglow-linux-$ARCH.tar.gz" | tar -xz -C "$TMP" ./autoglow; then
    echo "  - Download failed: building instead."
    exit 1
fi
# Renamed into place, so a running AutoGlow keeps its program until it restarts
install -m 755 "$TMP/autoglow" "$DIR/.autoglow.new"
mv -f "$DIR/.autoglow.new" "$DIR/autoglow"
