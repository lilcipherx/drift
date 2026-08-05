# Antigravity

Antigravity configures MCP servers through its settings UI (no config file).

## Steps

1. Open **Settings → MCP servers** in Antigravity.
2. Add a **local** MCP server:
   - **Name:** `drift`
   - **Command:** `npx`
   - **Args:** `-y @drift/mcp`
   - **Env:** `DRIFT_REPO=/abs/path/to/your/repo`
3. Save. Antigravity runs the server at session start, so Drift is active from
   the first message.

## Update

`npx -y @drift/mcp` always fetches the latest published version — restart
Antigravity to pick it up.

## Verify

Ask the agent to run `drift_log` — it should reply with the intent history
(or an empty table on a fresh repo).
