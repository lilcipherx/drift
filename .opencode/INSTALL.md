# Install Drift for OpenCode

Drift is installed in OpenCode as a local MCP server. Add this `mcp` block to
your `opencode.json` (note: OpenCode uses `environment`, not `env`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "drift": {
      "type": "local",
      "command": ["node", "/abs/path/to/drift/packages/drift-mcp/dist/index.js"],
      "environment": {
        "DRIFT_REPO": "/abs/path/to/your/repo"
      },
      "enabled": true
    }
  }
}
```

Replace the two placeholders:

| Placeholder | Replace with |
| :--- | :--- |
| `/abs/path/to/drift/packages/drift-mcp/dist/index.js` | absolute path to the MCP server (run `npm install` in the Drift repo first — `dist/` is committed) |
| `/abs/path/to/your/repo` | the repository Drift should operate on |

## Verify

```bash
opencode mcp list
```

You should see `drift`. The agent now has six tools: `drift_realize`,
`drift_context`, `drift_replay`, `drift_blame`, `drift_verify`, `drift_log`.

## Update

```bash
git -C /abs/path/to/drift pull origin main
cd /abs/path/to/drift && npm install
```
