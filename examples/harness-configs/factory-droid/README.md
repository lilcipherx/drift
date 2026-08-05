# Factory Droid

Droid exposes MCP servers through its settings / `mcp_servers` configuration.

## Steps

1. Open Droid's **MCP server settings** (or add an `mcp_servers` entry to its
   config file).
2. Add a **local** MCP server:
   - **Name:** `drift`
   - **Command:** `node`
   - **Args:** `/abs/path/to/drift/packages/drift-mcp/dist/index.js`
   - **Env:** `DRIFT_REPO=/abs/path/to/your/repo`
3. Restart Droid so the server connects at session start.

## Verify

Ask the agent to call `drift_context` on a file — it should reply with the last
intents that touched it.
