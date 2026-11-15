#!/usr/bin/env bash
# Builds the TV dashboard and Studio scripts for old TV browsers (Chrome 56+: webOS 4+, Tizen 2018+).
# Run after changing web/studio/js/*.js, then commit the three *.bundle.js files it writes.
# Needs Node: npx downloads esbuild on first use.
set -euo pipefail
cd "$(dirname "$0")/web/studio"
npx --yes esbuild@0.24.0 js/tournament.js --bundle --format=iife --target=chrome56 --legal-comments=none --outfile=js/tournament.bundle.js
npx --yes esbuild@0.24.0 js/main.js --bundle --format=iife --target=chrome56 --legal-comments=none --outfile=js/main.bundle.js
npx --yes esbuild@0.24.0 js/camera-worker.js --bundle --format=iife --target=chrome56 --legal-comments=none --outfile=js/camera-worker.bundle.js
