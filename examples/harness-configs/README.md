# Harness configs

Ready-to-use configuration files that wire the Drift MCP server
(`@drift/mcp`) into 11 coding-agent harnesses.

All examples use the same two placeholders — replace them with your paths:

| Placeholder | Replace with |
| :--- | :--- |
| `/abs/path/to/drift/packages/drift-mcp/dist/index.js` | absolute path to the built MCP server (run `npm install && npm run build` in the Drift repo first) |
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

## Verification

Once configured, every harness exposes the same six tools:

`drift_realize`, `drift_context`, `drift_replay`, `drift_blame`,
`drift_verify`, `drift_log`.
