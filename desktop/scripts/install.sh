#!/bin/sh
# Build the app, back up the installed copy, then install the new build into /Applications.
# Older builds were called Skm.app; that bundle is backed up and removed too.
set -eu
cd "$(dirname "$0")/.."
bun run pack
name="Skill Manager.app"
app=$(find dist -maxdepth 2 -name "$name" -type d | head -n 1)
[ -n "$app" ] || { echo "build produced no $name" >&2; exit 1; }
backups="$HOME/.skm/backups/app"
ts=$(date +%Y%m%d-%H%M%S)
for old in "/Applications/$name" /Applications/Skm.app; do
  [ -d "$old" ] || continue
  mkdir -p "$backups"
  mv "$old" "$backups/$(basename "$old").bak-$ts"
  echo "backed up $old to $backups/$(basename "$old").bak-$ts"
done
ditto "$app" "/Applications/$name"
echo "installed /Applications/$name"
