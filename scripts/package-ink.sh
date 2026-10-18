#!/usr/bin/env bash
# Build and zip the installable plugin folder for reMarkable Ink Round-Trip.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
id=$(node -p "require('./manifest.json').id")
version=$(node -p "require('./manifest.json').version")
out="release/${id}"
rm -rf release && mkdir -p "$out"
cp main.js manifest.json styles.css README-INK.md CHANGELOG-INK.md FONTS-LICENSE.md LICENSE "$out/"
(cd release && zip -qr "${id}-${version}.zip" "${id}")
echo "release/${id}-${version}.zip"
