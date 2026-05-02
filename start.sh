#!/bin/bash
# OpenClaw — Start all services and print the tunnel URL
PM2=/home/petrunix/.nvm/versions/node/v23.11.1/bin/pm2
REPO=/home/petrunix/openclaw-polymarket-kalshi-bots

echo "==> Stopping any running services..."
$PM2 delete all 2>/dev/null
pkill -f cloudflared 2>/dev/null
pkill -f vite 2>/dev/null
fuser -k 4001/tcp 3001/tcp 3002/tcp 2>/dev/null
sleep 2

echo "==> Starting all services via PM2..."
cd "$REPO" && $PM2 start ecosystem.config.cjs
$PM2 save

echo "==> Waiting for tunnel to connect..."
for i in $(seq 1 15); do
  CONN=$($PM2 logs tunnel --lines 20 --nostream 2>/dev/null | grep "Registered tunnel connection" | wc -l)
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
