#!/bin/sh
# icon/skm.svg -> icon/AppIcon.icns using only stock macOS tools (qlmanage, sips, iconutil).
set -eu
cd "$(dirname "$0")"
TMP="$(mktemp -d)"
qlmanage -t -s 1024 -o "$TMP" skm.svg >/dev/null 2>&1
MASTER="$TMP/skm.svg.png"
[ -f "$MASTER" ] || { echo "qlmanage did not render skm.svg" >&2; exit 1; }
SET="$TMP/AppIcon.iconset"; mkdir -p "$SET"
for px in 16 32 128 256 512; do
  sips -z "$px" "$px" "$MASTER" --out "$SET/icon_${px}x${px}.png" >/dev/null
  d=$((px * 2)); sips -z "$d" "$d" "$MASTER" --out "$SET/icon_${px}x${px}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o AppIcon.icns
rm -rf "$TMP"
echo "wrote $PWD/AppIcon.icns"
