# Harness configs

Ready-to-use configuration files that wire the Drift MCP server
(`packages/drift-mcp/dist/index.js`) into 11 coding-agent harnesses.

> **Status: the `@drift/*` npm packages are not published yet.** Every example
> below leads with the **clone path** — `node /abs/path/to/drift/packages/drift-mcp/dist/index.js` —
> which works right now from a checkout of this repository. The `npx -y @drift/mcp`
> one-liners activate automatically once the packages land on npm; until then
> they return a 404, so use the clone command shown first.

The only placeholders to replace:

| Placeholder | Replace with |
| :--- | :--- |
| `/abs/path/to/drift` | the directory where you checked out this repository |
| `/abs/path/to/your/repo` | the repository Drift should operate on (`DRIFT_REPO`) |

## File-based harnesses

| Harness | Config file | Install location |
| :--- | :--- | :--- |
| [Claude Code](claude-code/.mcp.json) | `mcpServers` block | project `.mcp.json`, or `claude mcp add` |
| [Cursor](cursor/mcp.json) | `mcpServers` block | `.cursor/mcp.json` |
| [Codex CLI](codex-cli/config.toml) | `[mcp_servers.drift]` | `~/.codex/config.toml` |
| [Gemini CLI](gemini-cli/settings.json) | `mcpServers` block | `.gemini/settings.json` (project) or `~/.gemini/settings.json` |
| [GitHub Copilot CLI](github-copilot-cli/mcp.json) | `mcpServers` block | `.github/mcp.json`, or `copilot mcp add` |
| [OpenCode](opencode/opencode.json) | `mcp` block (`environment`) | `opencode.json` |
| [Pi](pi/mcp.json) | `mcpServers` block | `.mcp.json` / `~/.pi/agent/mcp.json` (after `pi install npm:pi-mcp-adapter`) |

## Settings-panel harnesses (no config file)

These harnesses expose MCP servers through a settings UI instead of a file —
see each folder for the exact steps:

| Harness | Steps |
| :--- | :--- |
| [Antigravity](antigravity/README.md) | Settings → MCP servers → add local server |
| [Codex App](codex-app/README.md) | App settings → MCP servers → add local server |
| [Factory Droid](factory-droid/README.md) | Droid MCP settings → add local server |
| [Kimi Code](kimi-code/README.md) | Kimi Code MCP settings → add local server |

## After publication (npm)

Once the `@drift/*` packages are published, every config above can swap the
server command to `npx -y @drift/mcp` (no clone, no local path). For example,
the Claude Code block becomes:

```json
{
  "mcpServers": {
    "drift": {
      "command": "npx",
      "args": ["-y", "@drift/mcp"],
      "env": { "DRIFT_REPO": "/abs/path/to/your/repo" }
    }
  }
}
```

## Verification

Once configured, every harness exposes the same six tools:

`drift_realize`, `drift_context`, `drift_replay`, `drift_blame`,
`drift_verify`, `drift_log`.
