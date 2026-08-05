#!/usr/bin/env bash
# Publish the @drift package chain to npm and verify the MCP handshake via npx.
#
#   bash scripts/publish-npm.sh
#
# Run this from a terminal where `npm whoami` works (i.e. where you ran
# `npm adduser`). It publishes in dependency order (@drift/ast → @drift/core →
# @drift/cli → @drift/mcp), confirms each version on the registry, then
# launches `npx -y @drift/mcp` from an empty directory and checks the JSON-RPC
# handshake (initialize + tools/list).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "==> npm identity: $(npm whoami)"
echo "==> registry:     $(npm config get registry)"

# 1. Fresh build so dist/ matches src/ (dist is committed).
echo "==> npm run build"
npm run build

publish_pkg () {
  local pkg="$1"
  local dir="$2"
  local v got
  v="$(node -p "require('./${dir}/package.json').version")"
  echo "==> publishing ${pkg}@${v}"
  (cd "${dir}" && npm publish --access public)
  echo "==> waiting for the registry to confirm ${pkg}@${v}"
  for _ in $(seq 1 15); do
    got="$(npm view "${pkg}" version 2>/dev/null || true)"
    if [ "$got" = "$v" ]; then
      echo "    confirmed: ${pkg}@${got}"
      return 0
    fi
    sleep 2
  done
  echo "ERROR: registry did not confirm ${pkg}@${v} (last seen: ${got:-none})" >&2
  return 1
}

publish_pkg "@drift/ast"  "packages/drift-ast"
publish_pkg "@drift/core" "packages/drift-core"
publish_pkg "@drift/cli"  "packages/drift-cli"
publish_pkg "@drift/mcp"  "packages/drift-mcp"

echo
echo "==> handshake: npx -y @drift/mcp from an empty directory"
HANDSHAKE_DIR="$(mktemp -d)"
cd "${HANDSHAKE_DIR}"
cat > mcp-handshake.cjs <<'EOF'
const { spawn } = require("node:child_process");
const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(npxBin, ["-y", "@drift/mcp"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
let stage = 0;
const timer = setTimeout(() => { console.error("TIMEOUT: npx handshake did not complete"); process.exit(1); }, 180000);
child.on("error", (e) => { console.error("spawn error:", e.message); process.exit(1); });
child.on("exit", (code) => { if (stage < 2) { console.error("server exited early, code:", code); process.exit(1); } });
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1 && msg.result) {
      stage = 1;
      console.log("serverInfo:", JSON.stringify(msg.result.serverInfo));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    } else if (msg.id === 2 && msg.result) {
      stage = 2;
      const tools = (msg.result.tools || []).map((t) => t.name);
      console.log("tools/list (" + tools.length + "):", tools.join(", "));
      const ok = tools.length >= 6 && tools.includes("drift_realize") && tools.includes("drift_blame");
      clearTimeout(timer);
      child.kill();
      console.log(ok ? "HANDSHAKE OK" : "HANDSHAKE INCOMPLETE");
      process.exit(ok ? 0 : 1);
    }
  }
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "drift-publish-check", version: "1.0.0" } } }) + "\n");
EOF
node mcp-handshake.cjs
cd "${ROOT}"

echo
echo "==> ALL DONE: @drift/ast, @drift/core, @drift/cli, @drift/mcp published; npx handshake verified."
