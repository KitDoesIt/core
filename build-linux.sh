#!/bin/bash
# Builds standalone Asphyxia CORE binaries with `bun build --compile`.
# Cross-compiles linux-x64, linux-arm64 and windows-x64 from any host.
# When run from a Windows shell (Git Bash/MSYS), the real icon.ico is
# embedded in the Windows executable; Bun only allows --windows-icon
# when compiling on Windows.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p build

regex='VERSION = '"'"'([a-z0-9.]*)'"'"''
[[ $(cat ./src/utils/Consts.ts) =~ $regex ]]
VERSION=${BASH_REMATCH[1]}

echo "Building Version $VERSION"

if [ ! -d node_modules ]; then
  bun install --frozen-lockfile || bun install
fi

# Bundle assets/plugins once; they are shipped next to each binary.
rm -rf build/assets build/plugins
cp -r assets build/assets
cp -r plugins build/plugins

WINDOWS_HOST=0
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) WINDOWS_HOST=1 ;;
esac

pack() {
  local target="$1" name="$2" zipname="$3"
  shift 3
  echo "  -> $target"
  bun build --compile --target="$target" --outfile "build/$name" "$@" src/AsphyxiaCore.ts
  (cd build && rm -f "$zipname" && zip -qr "$zipname" "$(basename "$name")" assets plugins -x "plugins/node_modules/*" "plugins/*/node_modules/*")
}

pack bun-linux-x64   asphyxia-core         asphyxia-core-linux-x64.zip
pack bun-linux-arm64 asphyxia-core-arm64   asphyxia-core-arm64.zip
if [ "$WINDOWS_HOST" = "1" ]; then
  pack bun-windows-x64 asphyxia-core-x64.exe asphyxia-core-win-x64.zip --windows-icon=./icon.ico
else
  pack bun-windows-x64 asphyxia-core-x64.exe asphyxia-core-win-x64.zip
fi

echo "Done. Artifacts in ./build"
ls -1 build/*.zip
