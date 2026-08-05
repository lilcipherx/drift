#!/usr/bin/env bash
# Forward GitHub webhooks to a local drift-app via smee.io (PRD §16.3).
#
#   SMEE_URL=https://smee.io/your-channel bash scripts/webhook-proxy.sh
#   (default target port 3000 — set PORT to override)
set -euo pipefail

SMEE_URL="${SMEE_URL:?set SMEE_URL to your smee.io channel, e.g. https://smee.io/abc123}"
PORT="${PORT:-3000}"

echo "Forwarding $SMEE_URL → http://127.0.0.1:$PORT/webhook (Ctrl+C to stop)"
npx -y smee-client --url "$SMEE_URL" --port "$PORT" --path /webhook
