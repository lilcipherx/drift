# Drift for Kimi Code

Kimi Code installs Drift as a local MCP server.

## Install

- Open Kimi Code's plugin manager:

  ```text
  /plugins
  ```

- Go to `Marketplace` > `Drift` and install it.

Or install directly from this repository:

```text
/plugins install https://github.com/lilcipherx/drift
```

The plugin wires the Drift MCP server with a local `command` of
`npx -y @drift/mcp` (fetched from npm — no clone needed) and the
`DRIFT_REPO` environment variable set to the repository Drift should operate on
(see `examples/harness-configs/kimi-code/` for the exact fields).

## Tools

`drift_realize`, `drift_context`, `drift_replay`, `drift_blame`,
`drift_verify`, `drift_log`.

## Update

`npx -y @drift/mcp` always fetches the latest published version — just reinstall
the plugin (or restart Kimi) to pick it up.
