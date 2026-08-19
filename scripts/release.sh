#!/bin/sh
# One-command release: bump the version (default patch), commit+tag via
# npm version, push with tags — the publish.yml GitHub Action then publishes
# to npm through trusted publishing (no token, no OTP).
#
# Usage: sh scripts/release.sh [patch|minor|major|x.y.z]
set -eu

cd "$(dirname "$0")/.."
[ -z "$(git status --short)" ] || { echo "working tree not clean — commit first"; exit 1; }
npm version "${1:-patch}"
git push --follow-tags
echo "tag pushed — watch https://github.com/Minokun/dsh-quota/actions for the npm publish"
