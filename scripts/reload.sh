#!/bin/sh
# Rebuild dsh-quota. The profile mounts this package by its bare specifier
# ('dsh-quota'), which Node's ESM loader caches by URL for the life of the
# process, so HOST changes need a DSH restart; CLIENT (browser) changes are
# content-hashed into the boot graph and apply on a plain page refresh.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
pnpm build
echo "built. Host changes: restart dsh. Client changes: refresh the page (Cmd+R)."
