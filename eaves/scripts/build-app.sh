#!/bin/bash
# Builds Eaves.app, an installer package (.pkg) and a zip of the app into ./build.
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

# The installer: puts Eaves.app in /Applications. Marking the app as not relocatable stops the
# Installer from updating some other copy of Eaves it finds elsewhere on the disk instead.
PKG="build/Eaves-$VERSION.pkg"
PKG_ROOT="build/pkgroot"
mkdir -p "$PKG_ROOT/Applications"
ditto "$APP" "$PKG_ROOT/Applications/Eaves.app"
pkgbuild --analyze --root "$PKG_ROOT" build/component.plist > /dev/null
/usr/libexec/PlistBuddy -c "Set :0:BundleIsRelocatable false" build/component.plist
pkgbuild --root "$PKG_ROOT" --component-plist build/component.plist \
  --identifier com.eaves.personal.app.installer --version "$VERSION" --install-location / "$PKG"
rm -rf "$PKG_ROOT" build/component.plist

echo "Built $APP"
echo "Built $ZIP"
echo "Built $PKG"
lipo -archs "$APP/Contents/MacOS/Eaves" | sed 's/^/Architectures: /'
