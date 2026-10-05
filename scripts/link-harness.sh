#!/bin/sh
# Align this package's dev dependencies with the dsh it targets.
#
# Typecheck and build must resolve the SAME package generations the running dsh
# loads, or `tsc` happily accepts APIs the runtime no longer has (the
# `SessionListState.current` regression: the field was gone since
# dsh 0.1.6-alpha.2, yet a stale lib/types kept letting it through).
#
# Resolution order per package:
#   1. the INSTALLED dsh ($DSH_INSTALL, else the `dsh` on PATH / `npm root -g`)
#      — the exact runtime the plugin ships against;
#   2. the harness checkout's build (--harness, or $HARNESS) when editing dsh;
#   3. this repo's vendor/ copies (schemastery, cordis, dsh-client-store) for
#      installs that ship none of them.
#
# Usage: sh scripts/link-harness.sh [--harness] [dsh-root | harness-checkout]
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/node_modules/@deepseek-ai"

# Every dsh package this plugin imports (runtime or type-only).
PACKAGES="cordis schemastery dsh-tools dsh-settings dsh-credentials dsh-session \
dsh-host-webserver dsh-client-store dsh-client-ui-slots dsh-client-ui-layout dsh-client-ui-renderer \
dsh-client-ui-session dsh-api-session-controller dsh-client-ui-model-selection"

# Where each package lives inside a harness checkout (used for fallback/vendor
# resolution and for `--harness` mode).
harness_path_of() {
  case "$1" in
    cordis) echo vendor/cordis ;;
    schemastery) echo vendor/schemastery ;;
    dsh-tools) echo packages/core/tools ;;
    dsh-settings) echo packages/settings/settings ;;
    dsh-credentials) echo packages/credentials/credentials ;;
    dsh-session) echo packages/core/session ;;
    dsh-host-webserver) echo packages/host/webserver ;;
    dsh-client-store) echo vendor/dsh-client-store ;;
    dsh-client-ui-slots) echo packages/client/ui-slots ;;
    dsh-client-ui-layout) echo packages/client/ui-layout ;;
    dsh-client-ui-renderer) echo packages/client/ui-renderer ;;
    dsh-client-ui-session) echo packages/client/ui-session ;;
    dsh-api-session-controller) echo packages/api/session-controller ;;
    dsh-client-ui-model-selection) echo packages/client/ui-model-selection ;;
    *) echo "" ;;
  esac
}

mode=install
arg=""
for a in "$@"; do
  case "$a" in
    --harness) mode=harness ;;
    *) arg="$a" ;;
  esac
done

# ── the installed dsh ────────────────────────────────────────────────────────
install_modules=""
if [ "$mode" = "install" ]; then
  dsh_root="${arg:-${DSH_INSTALL:-}}"
  if [ -z "$dsh_root" ]; then
    npm_root="$(npm root -g 2>/dev/null || true)"
    [ -n "$npm_root" ] && [ -d "$npm_root/@deepseek-ai/dsh" ] && dsh_root="$npm_root/@deepseek-ai/dsh"
  fi
  if [ -z "$dsh_root" ]; then
    dsh_bin="$(command -v dsh 2>/dev/null || true)"
    if [ -n "$dsh_bin" ]; then
      # …/bin/dsh -> …/lib/node_modules/@deepseek-ai/dsh
      resolved="$(readlink -f "$dsh_bin" 2>/dev/null || echo "$dsh_bin")"
      dsh_root="$(cd "$(dirname "$resolved")/../.." 2>/dev/null && pwd)/@deepseek-ai/dsh"
    fi
  fi
  [ -n "$dsh_root" ] && [ -d "$dsh_root/node_modules/@deepseek-ai" ] && install_modules="$dsh_root/node_modules/@deepseek-ai"
fi

# ── the harness checkout ─────────────────────────────────────────────────────
harness="${HARNESS:-}"
if [ -z "$harness" ]; then
  candidate="$(cd "$ROOT/../../deepseek-harness" 2>/dev/null && pwd || true)"
  [ -n "$candidate" ] && harness="$candidate"
fi
if [ "$mode" = "harness" ] && [ -n "$arg" ]; then
  harness="$(cd "$arg" && pwd)"
fi

mkdir -p "$DEST"
linked=""
missing=""

for pkg in $PACKAGES; do
  if [ -n "$install_modules" ] && [ -d "$install_modules/$pkg" ]; then
    ln -sfn "$install_modules/$pkg" "$DEST/$pkg"
    linked="$linked $pkg"
    continue
  fi
  rel="$(harness_path_of "$pkg")"
  if [ -n "$harness" ] && [ -n "$rel" ] && [ -d "$harness/$rel" ]; then
    ln -sfn "$harness/$rel" "$DEST/$pkg"
    linked="$linked $pkg(harness)"
    continue
  fi
  if [ -d "$ROOT/vendor/$pkg" ]; then
    ln -sfn "../../vendor/$pkg" "$DEST/$pkg"
    linked="$linked $pkg(vendor)"
    continue
  fi
  missing="$missing $pkg"
done

# Drop links the plugin no longer resolves through: packages that are not part
# of the upstream tree at all (e.g. the pre-0.1.6 `dsh-client-runtime`).
for stale in dsh-client-runtime dsh-client-locale; do
  if [ -L "$DEST/$stale" ]; then
    rm -f "$DEST/$stale"
    echo "removed stale link @deepseek-ai/$stale"
  fi
done

echo "linked:$linked"
if [ -n "$missing" ]; then
  echo "missing (no installed dsh, harness checkout, or vendor copy):$missing" >&2
  exit 1
fi
