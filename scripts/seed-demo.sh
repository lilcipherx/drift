#!/usr/bin/env bash
# Seed examples/demo-repo with a real Drift history (dogfooding the CLI).
#
#   bash scripts/seed-demo.sh
#
# Creates a fully working demo repository: git history + .drift metadata +
# three intents (agent and human), so `drift log` / `drift blame` / `drift context`
# work immediately after opening it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_JS="$ROOT/packages/drift-cli/dist/cli.js"
DEMO="$ROOT/examples/demo-repo"
cli() { node "$CLI_JS" "$@"; }

# 1. build the CLI first if missing
if [ ! -f "$ROOT/packages/drift-cli/dist/cli.js" ]; then
  (cd "$ROOT" && npm run build >/dev/null)
fi

rm -rf "$DEMO"
mkdir -p "$DEMO/src"
cd "$DEMO"
git init -q -b main
git config user.name "Drift Demo"
git config user.email "demo@example.com"

cat > src/auth.ts <<'EOF'
export function verifyToken(token: string): boolean {
  return token.length > 0;
}
EOF

git add -A
git commit -qm "chore: scaffold demo project"

# 2. initialize drift (creates .drift/, SQLite DAG, Ed25519 key)
cli init >/dev/null

# 3. agent intent #1
cat > src/auth.ts <<'EOF'
export interface TokenPayload {
  sub: string;
  exp: number;
}

export function verifyToken(token: string): boolean {
  return token.length > 0;
}
EOF
cli realize -p "Add TokenPayload interface for JWT validation" \
  --agent --model "claude-3-5-sonnet" \
  --verify-cmd "npm test" >/dev/null

# 4. agent intent #2 (fixes the race condition from the PRD demo)
cat > src/auth.ts <<'EOF'
export interface TokenPayload {
  sub: string;
  exp: number;
}

let refreshInFlight: Promise<string> | null = null;

export function verifyToken(token: string): boolean {
  return token.length > 0;
}

export function refreshToken(expired: string): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = Promise.resolve(expired);
  return refreshInFlight;
}
EOF
cli realize -p "Fix race condition in token refresh by de-duplicating in-flight refreshes" \
  --agent --model "claude-3-5-sonnet" >/dev/null

# 5. human intent #3 (a reviewer's follow-up)
cat > src/auth.ts <<'EOF'
export interface TokenPayload {
  sub: string;
  exp: number;
}

let refreshInFlight: Promise<string> | null = null;

export function verifyToken(token: string): boolean {
  return token.length > 0;
}

export function refreshToken(expired: string): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = Promise.resolve(expired);
  return refreshInFlight;
}

export function clearRefreshCache(): void {
  refreshInFlight = null;
}
EOF
cli realize -p "Add clearRefreshCache for tests" --author "Drift Demo" >/dev/null

# 4. demo keys are throwaway — commit them so the demo works out of the box
git add -f .drift
git commit -qm "chore: seed drift intents"

echo ""
echo "✓ Demo repo seeded at examples/demo-repo"
echo "  try:   cd examples/demo-repo && node ../../packages/drift-cli/dist/cli.js log"
echo "  or:    node ../../packages/drift-cli/dist/cli.js blame src/auth.ts --function refreshToken"
