#!/bin/sh
# Sign the standalone skm CLI binaries with the Developer ID and notarize them, so a copy downloaded with a
# browser runs without a Gatekeeper prompt. (A bare Mach-O cannot hold a stapled ticket; Gatekeeper looks the
# notarization up online the first time.)
#
# usage: sh scripts/sign-cli.sh <binary>...
# env:   CSC_LINK          .p12 with the Developer ID Application certificate: a path, or the file base64-encoded
#        CSC_KEY_PASSWORD  its password
#        APPLE_API_KEY     path to the App Store Connect API key (.p8); with APPLE_API_KEY_ID and APPLE_API_ISSUER
# Without CSC_LINK it signs nothing and exits 0 (forks, local builds).
set -eu
[ "$#" -gt 0 ] || { echo "usage: sh scripts/sign-cli.sh <binary>..." >&2; exit 2; }
if [ -z "${CSC_LINK:-}" ]; then
  echo "sign-cli: CSC_LINK is not set; leaving the CLI binaries ad-hoc signed"
  exit 0
fi
: "${CSC_KEY_PASSWORD:?}" "${APPLE_API_KEY:?}" "${APPLE_API_KEY_ID:?}" "${APPLE_API_ISSUER:?}"
here=$(cd "$(dirname "$0")/.." && pwd)
entitlements="$here/build/entitlements.mac.plist"

work=$(mktemp -d)
keychain="$work/sign.keychain-db"
kcpass=$(openssl rand -hex 16)
old_list=$(security list-keychains -d user | tr -d '"' | xargs)
cleanup() {
  # shellcheck disable=SC2086 # the list is several paths
  security list-keychains -d user -s $old_list >/dev/null 2>&1 || true
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

if [ -f "$CSC_LINK" ]; then p12="$CSC_LINK"; else p12="$work/cert.p12"; printf %s "$CSC_LINK" | base64 --decode > "$p12"; fi
security create-keychain -p "$kcpass" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$kcpass" "$keychain"
security import "$p12" -k "$keychain" -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kcpass" "$keychain" >/dev/null
# a keychain outside the search list does not count for signing identities
# shellcheck disable=SC2086
security list-keychains -d user -s "$keychain" $old_list
identity=$(security find-identity -v -p codesigning "$keychain" | awk '/Developer ID Application/ { print $2; exit }')
[ -n "$identity" ] || { echo "sign-cli: no Developer ID Application identity in CSC_LINK" >&2; exit 1; }

for bin in "$@"; do
  codesign --force --options runtime --timestamp --entitlements "$entitlements" --keychain "$keychain" --sign "$identity" "$bin"
  codesign --verify --strict --verbose=1 "$bin"
  zip="$work/$(basename "$bin").zip"
  ditto -c -k --keepParent "$bin" "$zip"
  out=$(xcrun notarytool submit "$zip" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait 2>&1) || { echo "$out" >&2; exit 1; }
  echo "$out" | grep -q "status: Accepted" || { echo "$out" >&2; echo "sign-cli: notarization of $bin was not accepted" >&2; exit 1; }
  echo "sign-cli: $bin signed and notarized"
done
