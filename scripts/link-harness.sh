#!/bin/sh
# Link the runtime host dependencies from the deepseek-harness checkout into
# this package's node_modules so typecheck and build resolve the same module
# singletons the harness uses.
set -eu

HARNESS="${1:-$(cd "$(dirname "$0")/.." && pwd)/../deepseek-harness}"
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
