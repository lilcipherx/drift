# Codex App

The Codex desktop app configures MCP servers in its settings (Plugins section).

## Steps

1. Open **Settings → MCP servers** in the Codex app.
2. Add a **local** MCP server:
   - **Name:** `drift`
   - **Command:** `node`
   - **Args:** `/abs/path/to/drift/packages/drift-mcp/dist/index.js`
   - **Env:** `DRIFT_REPO=/abs/path/to/your/repo`
3. Save and follow the app's prompts to enable the server.

> **Status: the `@drift/*` npm packages are not published yet.** The command
> above points at a checkout of the Drift repository and works right now.
> Once the packages are published, replace it with Command `npx`, Args
> `-y @drift/mcp` (no clone needed).

## Verify

Ask the agent to call `drift_blame` on a file from your repository — it should
return the originating prompt for the relevant symbol.
