#!/bin/bash
# Builds "Memvana Shot.app": the Swift helper (extraction and the Photos
# bridge) inside a signed app bundle, so macOS can grant it Photos access.
#
#   scripts/build-app.sh             this Mac's architecture, into native/.build/app/
#   scripts/build-app.sh --release   universal, notarized and stapled, into bin/
#
# Signing uses the "Developer ID Application" identity in the keychain
# (override with SIGN_IDENTITY). Without one, a dev build is signed ad hoc
# under a separate ".dev" bundle ID, so it never disturbs the Photos
# permission granted to the real app. Notarizing uses the notarytool
# keychain profile in NOTARY_PROFILE (default: memvana-shot-notary).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE="$ROOT/native"
APP_NAME="Memvana Shot.app"
BUNDLE_ID="io.github.indieops-co.memvana-shot"
NOTARY_PROFILE="${NOTARY_PROFILE:-memvana-shot-notary}"

release=false
[[ "${1:-}" == "--release" ]] && release=true

version="$(sed -n 's/^let helperVersion = "\(.*\)"$/\1/p' "$NATIVE/Sources/shot-helper/main.swift")"
[[ -n "$version" ]] || { echo "could not read helperVersion from main.swift" >&2; exit 1; }

identity="${SIGN_IDENTITY:-$(security find-identity -v -p codesigning \
  | sed -n 's/.*"\(Developer ID Application: .*\)"$/\1/p' | head -1)}"
if [[ -z "$identity" ]]; then
  $release && { echo "a release needs a Developer ID Application identity" >&2; exit 1; }
  identity="-"
  BUNDLE_ID="$BUNDLE_ID.dev"
fi

if $release; then
  archs=(arm64 x86_64)
  out="$ROOT/bin"
else
  archs=("$(uname -m)")
  out="$NATIVE/.build/app"
fi

slices=()
for arch in "${archs[@]}"; do
  echo "→ building shot-helper $version ($arch)"
  swift build -c release --arch "$arch" --package-path "$NATIVE" >/dev/null
  slices+=("$(swift build -c release --arch "$arch" --package-path "$NATIVE" --show-bin-path)/shot-helper")
done

staging="$NATIVE/.build/app-staging"
app="$staging/$APP_NAME"
rm -rf "$staging"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
lipo -create "${slices[@]}" -output "$app/Contents/MacOS/shot-helper"
sed -e "s/__BUNDLE_ID__/$BUNDLE_ID/" -e "s/__VERSION__/$version/" "$NATIVE/App/Info.plist" > "$app/Contents/Info.plist"
plutil -lint -s "$app/Contents/Info.plist"
[[ -f "$NATIVE/App/AppIcon.icns" ]] && cp "$NATIVE/App/AppIcon.icns" "$app/Contents/Resources/"

if [[ "$identity" == "-" ]]; then signer="ad hoc"; else signer="$identity"; fi
echo "→ signing as $signer ($BUNDLE_ID)"
sign_args=(--force --sign "$identity" --options runtime --entitlements "$NATIVE/App/entitlements.plist")
[[ "$identity" != "-" ]] && sign_args+=(--timestamp)
codesign "${sign_args[@]}" "$app"
codesign --verify --strict "$app"

if $release; then
  echo "→ notarizing (usually 1–5 minutes)"
  zip="$staging/notarize.zip"
  ditto -c -k --keepParent "$app" "$zip"
  xcrun notarytool submit "$zip" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$app"
  spctl --assess --type exec -vv "$app"
  rm "$zip"
fi

mkdir -p "$out"
rm -rf "$out/$APP_NAME"
mv "$app" "$out/"
rm -rf "$staging"
echo "✓ $out/$APP_NAME ($version, $(lipo -archs "$out/$APP_NAME/Contents/MacOS/shot-helper"))"
