# Codex App

The Codex desktop app configures MCP servers in its settings (Plugins section).

## Steps

1. Open **Settings → MCP servers** in the Codex app.
2. Add a **local** MCP server:
   - **Name:** `drift`
   - **Command:** `npx`
   - **Args:** `-y @drift/mcp`
   - **Env:** `DRIFT_REPO=/abs/path/to/your/repo`
3. Save and follow the app's prompts to enable the server.

## Verify

Ask the agent to call `drift_blame` on a file from your repository — it should
return the originating prompt for the relevant symbol.
