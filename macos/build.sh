#!/bin/bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MACOS_DIR="$REPO_ROOT/macos"
BUILD_DIR="$MACOS_DIR/build"
APP="$BUILD_DIR/IAIMeterBar.app"
PLIST="$MACOS_DIR/Info.plist"

EXEC_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PLIST" 2>/dev/null || echo IAIMeterBar)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$PLIST" "$APP/Contents/Info.plist"

xcrun swiftc -O \
  -target "$(uname -m)-apple-macosx13.0" \
  -framework AppKit \
  -framework ServiceManagement \
  "$MACOS_DIR"/Sources/*.swift \
  -o "$APP/Contents/MacOS/$EXEC_NAME"

codesign --force --sign - "$APP"

echo "Built: $APP"
