#!/bin/bash
# Builds "Super Pixel Bros.app" (a double-clickable Mac app) next to this script.
# The app opens the game in its own app-style window using Chrome/Edge/Brave if
# installed, and otherwise falls back to your default browser (Safari).
set -e
cd "$(dirname "$0")"
APP="Super Pixel Bros.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/game"
cp index.html "$APP/Contents/Resources/game/index.html"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Super Pixel Bros</string>
  <key>CFBundleDisplayName</key><string>Super Pixel Bros</string>
  <key>CFBundleIdentifier</key><string>com.example.superpixelbros</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
</dict></plist>
PLIST
cat > "$APP/Contents/MacOS/launcher" <<'LAUNCH'
#!/bin/bash
GAME="$(cd "$(dirname "$0")/../Resources/game" && pwd)/index.html"
for B in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  if [ -d "/Applications/$B.app" ]; then
    exec open -na "$B" --args --app="file://$GAME" --window-size=980,760
  fi
done
exec open "$GAME"
LAUNCH
chmod +x "$APP/Contents/MacOS/launcher"
echo "Built: $(pwd)/$APP  (right-click > Open the first time if macOS warns about an unidentified developer)"
