#!/bin/bash
# OpenClaw — Start all services and print the tunnel URL
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$SCRIPT_DIR"
PM2_BIN="${PM2_BIN:-$(command -v pm2 || true)}"

if [ -z "$PM2_BIN" ]; then
  echo "pm2 not found in PATH. Load nvm/node first (e.g. 'source ~/.nvm/nvm.sh && nvm use')."
  exit 1
fi

if [ -f "$REPO/.env" ]; then
  set -a
  . "$REPO/.env"
  set +a
fi

if [ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  echo "Missing CLOUDFLARE_TUNNEL_TOKEN in .env; tunnel cannot start."
  exit 1
fi

echo "==> Stopping any running services..."
"$PM2_BIN" delete all 2>/dev/null || true
pkill -f cloudflared 2>/dev/null
pkill -f vite 2>/dev/null
fuser -k 4001/tcp 3001/tcp 3002/tcp 2>/dev/null
sleep 2

echo "==> Starting all services via PM2..."
cd "$REPO" && "$PM2_BIN" start ecosystem.config.cjs
"$PM2_BIN" save

echo "==> Waiting for tunnel to connect..."
for i in $(seq 1 15); do
  CONN=$("$PM2_BIN" logs tunnel --lines 20 --nostream 2>/dev/null | grep "Registered tunnel connection" | wc -l)
  if [ "$CONN" -ge 1 ]; then
    echo ""
    echo "============================================"
    echo "  Tunnel: CONNECTED (named tunnel: openclawbots)"
    echo "  Configure public hostname in Cloudflare Zero Trust dashboard"
    echo "============================================"
    exit 0
  fi
  sleep 2
done
echo "Tunnel not yet connected — run: pm2 logs tunnel"
