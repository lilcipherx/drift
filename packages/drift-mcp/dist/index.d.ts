#!/usr/bin/env node
/**
 * Drift MCP server (PRD §3.1, §14.2) — the agent-facing skill surface.
 *
 * Exposes capabilities agents did not have before:
 *   drift_realize  commit changes with intent, rejecting broken syntax
 *   drift_context  hydrate reasoning for a file
 *   drift_replay   restore a prior cognitive state
 *   drift_blame    ask "why does this function exist?"
 *   drift_verify   re-run an intent's verification command
 *   drift_log      inspect intent history
 *
 * Contract (PRD §11): this server never touches git or SQLite directly —
 * every tool delegates to the `drift` CLI as a child process.
 *
 * Configure the repo with the `DRIFT_REPO` env var (defaults to the server's
 * working directory).
 */
export {};
//# sourceMappingURL=index.d.ts.map