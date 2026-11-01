#!/bin/sh
# Start a release: check the versions, then tag and push. The Release workflow builds, signs and publishes it.
# Warning: pushing the tag publishes a public release on GitHub.
set -eu
cd "$(dirname "$0")/../.."
v=$(node -p 'require("./package.json").version')
dv=$(node -p 'require("./desktop/package.json").version')
[ "$v" = "$dv" ] || { echo "version mismatch: package.json $v, desktop/package.json $dv" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "commit your changes first" >&2; exit 1; }
git rev-parse "v$v" >/dev/null 2>&1 && { echo "tag v$v already exists" >&2; exit 1; }
git tag -a "v$v" -m "Skill Manager $v"
git push origin "v$v"
echo "pushed v$v; follow the Release workflow on GitHub"
