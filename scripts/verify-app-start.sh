#!/usr/bin/env bash
# Live check for `drift-app start` (ADR-008 / adversarial-review security fix):
#   CASE 1 — without GITHUB_WEBHOOK_SECRET it must fail fast with a clear error
#            and exit 1 (a public /webhook endpoint without HMAC is forgeable).
#   CASE 2 — with the secret (and a throwaway App key) it must boot, answer
#            /health, 404 on non-POST /webhook, ack a bad signature as
#            non-retryable, and shut down gracefully on SIGTERM.
# Usage: bash scripts/verify-app-start.sh
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$REPO_ROOT/packages/drift-app/dist/index.js"
if [ ! -f "$DIST" ]; then
  echo "build missing at $DIST — run 'npm run build' first" >&2
  exit 1
fi

fail=0

echo "=== CASE 1: start WITHOUT GITHUB_WEBHOOK_SECRET ==="
out="$(env -u GITHUB_WEBHOOK_SECRET GITHUB_APP_ID=1 GITHUB_PRIVATE_KEY=x node "$DIST" start 2>&1)"
code=$?
echo "$out"
echo "exit=$code"
if [ "$code" -ne 1 ] || ! printf '%s' "$out" | grep -q "GITHUB_WEBHOOK_SECRET is required for drift-app start"; then
  echo "FAIL: expected a clear error and exit 1" >&2
  fail=1
fi

echo
echo "=== CASE 2: start WITH secret -> /health ==="
KEY="$(mktemp)"
LOG="$(mktemp)"
node -e "const {generateKeyPairSync}=require('node:crypto');const fs=require('node:fs');fs.writeFileSync(process.argv[1],generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'}))" "$KEY"
GITHUB_WEBHOOK_SECRET=test-secret GITHUB_APP_ID=12345 GITHUB_PRIVATE_KEY="$KEY" PORT=0 node "$DIST" start >"$LOG" 2>&1 &
SRV=$!
PORT=""
for i in $(seq 1 40); do
  sleep 0.25
  PORT="$(grep -o 'http://127.0.0.1:[0-9]*' "$LOG" 2>/dev/null | head -1 | sed 's#http://127.0.0.1:##')"
  [ -n "$PORT" ] && break
done
cat "$LOG"
if [ -z "$PORT" ]; then
  echo "FAIL: server did not report a listening port" >&2
  kill -KILL "$SRV" 2>/dev/null
  rm -f "$KEY" "$LOG"
  exit 1
fi
echo "port=$PORT"

health="$(curl -s -w '\n%{http_code}' "http://127.0.0.1:$PORT/health")"
echo "GET /health: $health"
printf '%s' "$health" | grep -q '"status":"ok"' || { echo "FAIL: /health did not answer ok" >&2; fail=1; }

notfound="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/webhook")"
echo "GET /webhook http=$notfound (expect 404)"
[ "$notfound" = "404" ] || { echo "FAIL: expected 404 for non-POST /webhook" >&2; fail=1; }

bad="$(curl -s -X POST -H 'content-type: application/json' -H 'x-github-event: pull_request' -H 'x-hub-signature-256: sha256=deadbeef' -d '{"action":"opened"}' "http://127.0.0.1:$PORT/webhook")"
echo "POST /webhook bad signature: $bad"
printf '%s' "$bad" | grep -q '"retryable":false' || { echo "FAIL: bad signature must be acked as non-retryable" >&2; fail=1; }

kill -TERM "$SRV"
wait "$SRV" 2>/dev/null
srv_exit=$?
case "$(uname -s 2>/dev/null)" in
  *MINGW*|*MSYS*|*CYGWIN*|*_NT-*|*NT*) IS_WIN=1 ;;
  *) IS_WIN=0 ;;
esac
if [ "$IS_WIN" = "1" ]; then
  # Node on Windows does not emulate SIGTERM as an event — it is delivered via
  # unconditional TerminateProcess, so the JS handler cannot run (documented
  # platform limitation). The graceful handler is a POSIX path.
  echo "server exit after SIGTERM=$srv_exit (Windows: unconditional terminate, 143 expected; handler is POSIX-only)"
  [ "$srv_exit" -eq 143 ] || { echo "FAIL: expected 143 (unconditional terminate) on Windows" >&2; fail=1; }
else
  echo "server exit after SIGTERM=$srv_exit (expect 0 — graceful)"
  [ "$srv_exit" -eq 0 ] || { echo "FAIL: expected graceful exit 0 on SIGTERM" >&2; fail=1; }
fi
# the port must be released afterwards
if curl -s --max-time 2 -o /dev/null "http://127.0.0.1:$PORT/health"; then
  echo "FAIL: server still answering after termination" >&2
  fail=1
else
  echo "port $PORT released after termination"
fi

rm -f "$KEY" "$LOG"
if [ "$fail" -eq 0 ]; then
  echo
  echo "ALL CHECKS PASSED"
else
  echo
  echo "CHECKS FAILED" >&2
  exit 1
fi
