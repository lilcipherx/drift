# Antigravity

Antigravity configures MCP servers through its settings UI (no config file).

## Steps

1. Open **Settings → MCP servers** in Antigravity.
2. Add a **local** MCP server:
   - **Name:** `drift`
   - **Command:** `node`
   - **Args:** `/abs/path/to/drift/packages/drift-mcp/dist/index.js`
   - **Env:** `DRIFT_REPO=/abs/path/to/your/repo`
3. Save. Antigravity runs the server at session start, so Drift is active from
   the first message.

> **Status: the `@drift/*` npm packages are not published yet.** The command
> above points at a checkout of the Drift repository and works right now.
> Once the packages are published, replace it with Command `npx`, Args
> `-y @drift/mcp` (no clone needed).

## Update

From a clone, pull and reinstall — then restart Antigravity:

```bash
git pull && npm install
```

Once published, `npx -y @drift/mcp` always fetches the latest release —
restart Antigravity to pick it up.

## Verify

Ask the agent to run `drift_log` — it should reply with the intent history
(or an empty table on a fresh repo).
