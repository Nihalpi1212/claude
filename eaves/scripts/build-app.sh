#!/bin/bash
# Builds Eaves.app and a zip of it into ./build.
#
#   ./scripts/build-app.sh            build for this Mac (needs the Xcode Command Line Tools)
#   UNIVERSAL=1 ./scripts/build-app.sh   build for Apple silicon and Intel together (needs Xcode)
#
# The app is signed ad hoc: enough to run on your own Mac, not an Apple Developer ID signature.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(tr -d '[:space:]' < VERSION)"
FLAGS=(-c release)
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  FLAGS+=(--arch arm64 --arch x86_64)
fi

swift build "${FLAGS[@]}"
BIN_DIR="$(swift build "${FLAGS[@]}" --show-bin-path)"

APP="build/Eaves.app"
rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/Eaves" "$APP/Contents/MacOS/Eaves"
sed "s/__VERSION__/$VERSION/g" packaging/Info.plist > "$APP/Contents/Info.plist"

# The icon: one 1024 px picture scaled into every size macOS asks for.
ICONSET="build/Eaves.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" packaging/icon-1024.png --out "$ICONSET/icon_${size}x${size}.png" > /dev/null
  double=$((size * 2))
  sips -z "$double" "$double" packaging/icon-1024.png --out "$ICONSET/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Eaves.icns"
rm -rf "$ICONSET"

codesign --force --sign - "$APP"
codesign --verify --strict "$APP"

ZIP="build/Eaves-$VERSION-mac.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "Built $APP"
echo "Built $ZIP"
lipo -archs "$APP/Contents/MacOS/Eaves" | sed 's/^/Architectures: /'
