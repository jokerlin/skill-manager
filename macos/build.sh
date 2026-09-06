#!/bin/sh
# Build Skm.app (SwiftUI shell over the skm CLI). Usage: sh macos/build.sh [debug|release]
set -eu
cd "$(dirname "$0")"
CONF="${1:-release}"
LOG="$(mktemp)"
if ! swift build -c "$CONF" >"$LOG" 2>&1; then grep -E "error:|warning:" "$LOG" | head -20; echo "swift build failed"; rm -f "$LOG"; exit 1; fi
grep -E "error:" "$LOG" | head -5; rm -f "$LOG"
BIN=".build/$CONF/Skm"
APP="dist/Skm.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Skm"
[ -f icon/AppIcon.icns ] || sh icon/make-icns.sh   # regenerate from icon/skm.svg when missing
cp icon/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>skm</string>
  <key>CFBundleDisplayName</key><string>skm</string>
  <key>CFBundleIdentifier</key><string>dev.skm.app</string>
  <key>CFBundleExecutable</key><string>Skm</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "built $PWD/$APP"
# Keep the copy Raycast/Spotlight launch in step with the build: replace /Applications/Skm.app whenever it exists.
INSTALLED="/Applications/Skm.app"
if [ -d "$INSTALLED" ]; then
  rm -rf "$INSTALLED" && ditto "$APP" "$INSTALLED" && echo "installed $INSTALLED"
fi
