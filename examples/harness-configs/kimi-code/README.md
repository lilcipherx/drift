# Kimi Code

Kimi Code configures MCP servers in its plugin/MCP manager.

## Steps

1. Open Kimi Code's **MCP settings**.
2. Add a **local** MCP server:
   - **Name:** `drift`
   - **Command:** `node`
   - **Args:** `/abs/path/to/drift/packages/drift-mcp/dist/index.js`
   - **Env:** `DRIFT_REPO=/abs/path/to/your/repo`
3. Save and approve the server when prompted.

## Verify

Ask the agent to call `drift_realize` after an edit — it should commit the
change as an intent instead of a plain commit.
