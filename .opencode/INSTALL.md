# Install Drift for OpenCode

Drift is installed in OpenCode as a local MCP server. Add this `mcp` block to
your `opencode.json` (note: OpenCode uses `environment`, not `env`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "drift": {
      "type": "local",
      "command": ["npx", "-y", "@drift/mcp"],
      "environment": {
        "DRIFT_REPO": "/abs/path/to/your/repo"
      },
      "enabled": true
    }
  }
}
```

The server runs from npm via `npx` — no clone needed. The only placeholder to
replace:

| Placeholder | Replace with |
| :--- | :--- |
| `/abs/path/to/your/repo` | the repository Drift should operate on |

## Verify

```bash
opencode mcp list
```

You should see `drift`. The agent now has six tools: `drift_realize`,
`drift_context`, `drift_replay`, `drift_blame`, `drift_verify`, `drift_log`.

## Update

`npx -y @drift/mcp` always fetches the latest published version — restart
OpenCode (or run `opencode mcp reload`) to pick it up.
