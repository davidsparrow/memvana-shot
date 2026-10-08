#!/bin/bash
# Checks the shipped bin/Memvana Shot.app: built from the current Swift
# version, for both architectures, signed by the expected team, and notarized
# with the ticket stapled. CI runs this; scripts/build-app.sh --release fixes it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/bin/Memvana Shot.app"
TEAM_ID="3YL7B839MT"
BUNDLE_ID="io.github.indieops-co.memvana-shot"

fail() { echo "::error::$1 Run 'npm run release:app' and commit bin/." >&2; exit 1; }

[[ -d "$APP" ]] || fail "bin/Memvana Shot.app is missing."
source_version="$(sed -n 's/^let helperVersion = "\(.*\)"$/\1/p' "$ROOT/native/Sources/shot-helper/main.swift")"
app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
[[ "$app_version" == "$source_version" ]] || fail "The shipped app is $app_version but the Swift source is $source_version."
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")" == "$BUNDLE_ID" ]] \
  || fail "The shipped app's bundle ID isn't $BUNDLE_ID."
archs="$(lipo -archs "$APP/Contents/MacOS/shot-helper")"
[[ "$archs" == *arm64* && "$archs" == *x86_64* ]] || fail "The shipped app isn't universal ($archs)."
codesign --verify --strict "$APP" || fail "The shipped app's signature is invalid."
signature="$(codesign -dv "$APP" 2>&1)"
grep -qx "TeamIdentifier=$TEAM_ID" <<< "$signature" || fail "The shipped app isn't signed by team $TEAM_ID."
xcrun stapler validate -q "$APP" || fail "The shipped app has no stapled notarization ticket."
echo "✓ bin/Memvana Shot.app $app_version ($archs), signed by $TEAM_ID and notarized"
