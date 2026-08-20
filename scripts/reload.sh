#!/bin/sh
# Rebuild dsh-quota and soft-restart the running DSH via the dsh-market
# restart endpoint (loopback + same-origin POST). The harness spawns a
# detached replacement process: sessions survive, the page reconnects.
#
# Client-only changes need no restart — just refresh the page.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${DSH_WEB_PORT:-3080}"

cd "$REPO"
pnpm build

# dsh-market restart endpoint: requires loopback peer, no forwarding headers,
# and Origin matching the Host header.
resp=$(curl -s --max-time 10 -X POST -H "Origin: http://127.0.0.1:$PORT" -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/dsh-market/restart" || true)
case "$resp" in
  202) echo "built; DSH is restarting (page will reconnect in a few seconds)" ;;
  000) echo "built; no running dsh web on :$PORT — start it to pick up host changes" ;;
  403|404) echo "built; market restart endpoint unavailable (HTTP $resp) — restart dsh manually" ;;
  *) echo "built; restart endpoint answered HTTP $resp" ;;
esac
