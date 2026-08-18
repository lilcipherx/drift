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
# Optional target dir (docs-commands-test seeds into a temp dir so the
# committed demo snapshot is never rewritten); default: the committed demo.
DEMO="${1:-$ROOT/examples/demo-repo}"
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
  --summary "Add TokenPayload interface for JWT validation" \
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
  --summary "Fix race condition in token refresh" \
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
cli realize -p "Add clearRefreshCache for tests" \
  --summary "Add clearRefreshCache for tests" --author "Drift Demo" >/dev/null

# 3b. README for the checked-out example
cat > README.md <<'EOF'
# Drift demo repository

A real Drift history you can walk through in two minutes. Only public
provenance (`.drift/public/`, `config.toml`, `.gitignore`) is committed —
see the copy at the repository root for the full walkthrough.
EOF

# 4. Each `drift realize` above already committed source + signed public
#    manifest + key + trailer atomically (ADR-009 V2). The SQLite DB,
#    content-addressed objects and the signing key stay untracked — `git add
#    .` can never stage them (see .drift/.gitignore). This final commit only
#    adds the walkthrough README.
git add README.md
git commit -qm "docs: demo walkthrough"

# 5. sanity: prove `git add .` cannot stage private Drift data
if git check-ignore -q .drift/drift.db && git check-ignore -q .drift/keys/ed25519.pem; then
  echo "✓ private .drift data is gitignored"
else
  echo "ERROR: private .drift data is not ignored" >&2
  exit 1
fi

echo ""
echo "✓ Demo repo seeded at examples/demo-repo"
echo "  try:   cd examples/demo-repo && node ../../packages/drift-cli/dist/cli.js log"
echo "  or:    node ../../packages/drift-cli/dist/cli.js blame src/auth.ts --function refreshToken"
echo "  note:  .drift/drift.db, objects/ and keys/ are present locally but gitignored"
