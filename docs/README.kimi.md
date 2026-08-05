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
`node /abs/path/to/drift/packages/drift-mcp/dist/index.js` and the
`DRIFT_REPO` environment variable set to the repository Drift should operate on
(see `examples/harness-configs/kimi-code/` for the exact fields).

## Tools

`drift_realize`, `drift_context`, `drift_replay`, `drift_blame`,
`drift_verify`, `drift_log`.

## Update

Pull the latest Drift, rebuild, and reinstall the plugin.
