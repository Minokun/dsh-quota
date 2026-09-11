#!/bin/sh
# Link the runtime host dependencies from the deepseek-harness checkout into
# this package's node_modules so typecheck and build resolve the same module
# singletons the harness uses.
set -eu

HARNESS="${1:-$(cd "$(dirname "$0")/.." && pwd)/../../deepseek-harness}"
HARNESS="$(cd "$HARNESS" && pwd)"
DEST="$(cd "$(dirname "$0")/.." && pwd)/node_modules/@deepseek-ai"

mkdir -p "$DEST"
for spec in \
  "dsh-tools:packages/core/tools" \
  "dsh-settings:packages/settings/settings" \
  "dsh-credentials:packages/credentials/credentials" \
  "dsh-session:packages/core/session" \
  "dsh-host-webserver:packages/host/webserver" \
  "dsh-client-runtime:packages/client/runtime" \
  "dsh-client-ui-slots:packages/client/ui-slots" \
  "dsh-client-locale:packages/client/locale" \
  "schemastery:vendor/schemastery" \
  "cordis:vendor/cordis"
do
  name="${spec%%:*}"
  rel="${spec#*:}"
  target="$HARNESS/$rel"
  if [ ! -d "$target" ]; then
    echo "missing $target" >&2
    exit 1
  fi
  ln -sfn "$target" "$DEST/$name"
  echo "linked @deepseek-ai/$name -> $target"
done

# dsh-client-store is NOT a package in the harness checkout and the global dsh
# install no longer ships it as a standalone package (dsh >= 0.1.5 bundles
# everything). Vendor the last standalone build (0.1.2-alpha.1) in-repo; the
# browser bundle treats it as external (seeded by the web shell) and only
# typecheck/build resolve it locally.
STORE_VENDOR="$(cd "$(dirname "$0")/.." && pwd)/vendor/dsh-client-store"
if [ -d "$STORE_VENDOR" ]; then
  ln -sfn "../../vendor/dsh-client-store" "$DEST/dsh-client-store"
  echo "linked @deepseek-ai/dsh-client-store -> vendor/dsh-client-store"
fi
