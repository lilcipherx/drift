# Drift for OpenCode

OpenCode installs Drift as a local MCP server. The fastest path:

```
Fetch and follow instructions from https://raw.githubusercontent.com/lilcipherx/drift/main/.opencode/INSTALL.md
```

Or add the `mcp` block to `opencode.json` manually — see
[`.opencode/INSTALL.md`](../.opencode/INSTALL.md) for the full config with
placeholders.

## Tools

| Tool | What it does |
| :--- | :--- |
| `drift_realize` | Commit the current change as an intent (prompt, AST delta, signature) |
| `drift_context` | Last intents for a file — ground yourself before editing |
| `drift_blame` | Originating prompt + model for a line or function |
| `drift_verify` | Re-run an intent's verification command and check its signature |
| `drift_replay` | Restore a checkpointed agent state |
| `drift_log` | Intent history for the repository |
