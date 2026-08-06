#!/usr/bin/env bash
# MVS v0.1.0 acceptance test (PRD §4.2) — runs on a fresh repo against the local CLI build.
# Usage: bash scripts/acceptance-mvs.sh
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$REPO_ROOT/packages/drift-cli/dist/cli.js"

if [ ! -f "$CLI" ]; then
  echo "CLI build not found at $CLI — run 'npm run build' first" >&2
  exit 1
fi

drift() { node "$CLI" "$@"; }

T="$(mktemp -d)/accept"
mkdir -p "$T/src"
cd "$T"
git init -q -b main .
git config user.email t@t
git config user.name T

printf 'export function verifyToken(tok: string): boolean {\n  return tok.length > 10;\n}\n' > src/auth.ts
git add -A && git commit -qm init

echo "--- drift init ---"
drift init

echo "--- edit file ---"
printf 'export function verifyToken(tok: string): boolean {\n  const parts = tok.split(".");\n  return parts.length === 3 && parts[2].length > 10;\n}\n' > src/auth.ts

echo "--- drift realize ---"
drift realize -p "Fix race condition in token refresh" --json

echo "--- drift log ---"
drift log --json

echo "--- drift blame ---"
drift blame src/auth.ts --function verifyToken --json

echo "--- verify-intent on last intent ---"
LAST_ID="$(drift log --json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.intents[0].id)})")"
drift verify-intent "$LAST_ID" --json

echo "--- syntax gate: realize with broken code must fail with exit 2 ---"
printf 'export function broken( {\n' > src/broken.ts
drift realize -p "add broken fn" --json
echo "syntax-gate exit=$?"

echo "--- realize on clean tree must fail with exit 3 (E_NO_CHANGES) ---"
rm src/broken.ts
drift realize -p "x" --json
echo "no-changes exit=$?"
