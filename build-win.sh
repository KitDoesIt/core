#!/bin/bash
# Cross-compiles a Windows x64 Asphyxia CORE binary from Linux/macOS.
# Note: Bun cannot embed --windows-icon when cross-compiling; use
# build-win.ps1 on Windows for the icon.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p build

regex='VERSION = '"'"'([a-z0-9.]*)'"'"''
[[ $(cat ./src/utils/Consts.ts) =~ $regex ]]
VERSION=${BASH_REMATCH[1]}

echo "Building Version $VERSION for Windows x64"

if [ ! -d node_modules ]; then
  bun install --frozen-lockfile || bun install
fi

bun build --compile --target=bun-windows-x64 --outfile build/asphyxia-core-x64.exe src/AsphyxiaCore.ts

rm -rf build/assets build/plugins
cp -r assets build/assets
cp -r plugins build/plugins

cd build
rm -f asphyxia-core-win-x64.zip
zip -qr asphyxia-core-win-x64.zip asphyxia-core-x64.exe assets plugins -x "plugins/node_modules/*" "plugins/*/node_modules/*"
echo "Done: build/asphyxia-core-win-x64.zip"
