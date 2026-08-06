# Audit Ledger

Release audit (final): every tracked file reviewed. Source files read line-by-line; configs/manifests/docs inspected; dist rebuilt from fixed sources and re-verified by the full suite + live CLI/MCP/edge/security runs. Live verification: npm test 109/109, eval gate passed, MVS acceptance passed, CLI E2E 24/24, MCP E2E all pass, edge+security 31/31, action.yml simulated. ACCEPTED-RISK entries are the only non-fixed ones.

## File coverage (100%)

| Status | File |
|---|---|
| FIXED | CHANGELOG.md |
| FIXED | package.json |
| PASS | README.md |
| PASS | .claude-plugin/marketplace.json |
| PASS | .claude-plugin/plugin.json |
| PASS | .codex-plugin/plugin.json |
| PASS | .cursor-plugin/plugin.json |
| PASS | .factory-plugin/marketplace.json |
| PASS | .factory-plugin/plugin.json |
| PASS | .github/PULL_REQUEST_TEMPLATE.md |
| PASS | .gitignore |
| PASS | .opencode/INSTALL.md |
| PASS | .plugin/plugin.json |
| PASS | action.yml |
| PASS | CODE_OF_CONDUCT.md |
| PASS | CONTRIBUTING.md |
| PASS | docs/README.kimi.md |
| PASS | docs/README.opencode.md |
| PASS | docs/adrs.md |
| PASS | docs/api.md |
| PASS | docs/architecture.md |
| PASS | docs/assets/drift-hero.png |
| PASS | docs/quickstart.md |
| PASS | Drift (Intent-Driven Versioning).md |
| PASS | eval/baseline.json |
| PASS | eval/harness.mjs |
| PASS | eval/scenarios/realize-blame.json |
| PASS | eval/scenarios/syntax-error-retry.json |
| PASS | examples/claude-code-integration/mcp.json |
| PASS | examples/demo-repo/.drift/.gitignore |
| PASS | examples/demo-repo/.drift/config.toml |
| PASS | examples/demo-repo/.drift/drift.db |
| PASS | examples/demo-repo/.drift/objects/47/f580dbb64b66e929a8e5a5b0c4a5e0b9a9c33ccbe3e55c7509aac803cc6c11.json |
| PASS | examples/demo-repo/.drift/objects/53/c7f2e2401162ad712c6d6ce1cf3c42aa8ffd36574ae9bc9ffaea253b2f0ea3.json |
| PASS | examples/demo-repo/.drift/objects/d5/a35fd199a852127f2a6ef22f5a2b1a08aa05912340da0ded14d4f46b9c574f.json |
| PASS | examples/demo-repo/src/auth.ts |
| PASS | examples/harness-configs/README.md |
| PASS | examples/harness-configs/antigravity/README.md |
| PASS | examples/harness-configs/claude-code/.mcp.json |
| PASS | examples/harness-configs/codex-app/README.md |
| PASS | examples/harness-configs/codex-cli/config.toml |
| PASS | examples/harness-configs/cursor/mcp.json |
| PASS | examples/harness-configs/factory-droid/README.md |
| PASS | examples/harness-configs/gemini-cli/settings.json |
| PASS | examples/harness-configs/github-copilot-cli/mcp.json |
| PASS | examples/harness-configs/kimi-code/README.md |
| PASS | examples/harness-configs/opencode/opencode.json |
| PASS | examples/harness-configs/pi/mcp.json |
| PASS | examples/payloads/pull_request.opened.json |
| PASS | gemini-extension.json |
| PASS | LICENSE |
| PASS | mcp_config.json |
| PASS | mcp.json |
| PASS | migrations/001_init.sql |
| PASS | NEXT_STEPS.md |
| FIXED | package-lock.json |
| FIXED | packages/drift-action/package.json |
| PASS | packages/drift-app/app.yml |
| PASS | packages/drift-app/dist/github.d.ts |
| PASS | packages/drift-app/dist/github.d.ts.map |
| PASS | packages/drift-app/dist/github.js |
| PASS | packages/drift-app/dist/github.js.map |
| PASS | packages/drift-app/dist/handler.d.ts |
| PASS | packages/drift-app/dist/handler.d.ts.map |
| PASS | packages/drift-app/dist/handler.js |
| PASS | packages/drift-app/dist/handler.js.map |
| PASS | packages/drift-app/dist/index.d.ts |
| PASS | packages/drift-app/dist/index.d.ts.map |
| PASS | packages/drift-app/dist/index.js |
| PASS | packages/drift-app/dist/index.js.map |
| PASS | packages/drift-app/dist/intents.d.ts |
| PASS | packages/drift-app/dist/intents.d.ts.map |
| PASS | packages/drift-app/dist/intents.js |
| PASS | packages/drift-app/dist/intents.js.map |
| PASS | packages/drift-app/dist/jwt.d.ts |
| PASS | packages/drift-app/dist/jwt.d.ts.map |
| PASS | packages/drift-app/dist/jwt.js |
| PASS | packages/drift-app/dist/jwt.js.map |
| PASS | packages/drift-app/dist/server.d.ts |
| PASS | packages/drift-app/dist/server.d.ts.map |
| PASS | packages/drift-app/dist/server.js |
| PASS | packages/drift-app/dist/server.js.map |
| PASS | packages/drift-app/dist/summarize.d.ts |
| PASS | packages/drift-app/dist/summarize.d.ts.map |
| PASS | packages/drift-app/dist/summarize.js |
| PASS | packages/drift-app/dist/summarize.js.map |
| FIXED | packages/drift-app/package.json |
| PASS | packages/drift-app/src/github.ts |
| PASS | packages/drift-app/src/handler.ts |
| PASS | packages/drift-app/src/index.ts |
| PASS | packages/drift-app/src/intents.ts |
| PASS | packages/drift-app/src/jwt.ts |
| PASS | packages/drift-app/src/server.ts |
| PASS | packages/drift-app/src/summarize.ts |
| PASS | packages/drift-app/tsconfig.json |
| PASS | packages/drift-ast/dist/index.d.ts |
| PASS | packages/drift-ast/dist/index.d.ts.map |
| PASS | packages/drift-ast/dist/index.js |
| PASS | packages/drift-ast/dist/index.js.map |
| FIXED | packages/drift-ast/package.json |
| PASS | packages/drift-ast/src/index.ts |
| PASS | packages/drift-ast/tsconfig.json |
| PASS | packages/drift-cli/dist/cli.d.ts |
| PASS | packages/drift-cli/dist/cli.d.ts.map |
| PASS | packages/drift-cli/dist/cli.js |
| PASS | packages/drift-cli/dist/cli.js.map |
| FIXED | packages/drift-cli/package.json |
| PASS | packages/drift-cli/src/cli.ts |
| PASS | packages/drift-cli/tsconfig.json |
| FIXED | packages/drift-core/dist/config.d.ts |
| FIXED | packages/drift-core/dist/config.d.ts.map |
| FIXED | packages/drift-core/dist/config.js |
| FIXED | packages/drift-core/dist/config.js.map |
| PASS | packages/drift-core/dist/crypto.d.ts |
| PASS | packages/drift-core/dist/crypto.d.ts.map |
| PASS | packages/drift-core/dist/crypto.js |
| PASS | packages/drift-core/dist/crypto.js.map |
| PASS | packages/drift-core/dist/engine.d.ts |
| FIXED | packages/drift-core/dist/engine.d.ts.map |
| FIXED | packages/drift-core/dist/engine.js |
| FIXED | packages/drift-core/dist/engine.js.map |
| PASS | packages/drift-core/dist/errors.d.ts |
| PASS | packages/drift-core/dist/errors.d.ts.map |
| PASS | packages/drift-core/dist/errors.js |
| PASS | packages/drift-core/dist/errors.js.map |
| PASS | packages/drift-core/dist/git.d.ts |
| PASS | packages/drift-core/dist/git.d.ts.map |
| PASS | packages/drift-core/dist/git.js |
| PASS | packages/drift-core/dist/git.js.map |
| PASS | packages/drift-core/dist/index.d.ts |
| PASS | packages/drift-core/dist/index.d.ts.map |
| PASS | packages/drift-core/dist/index.js |
| PASS | packages/drift-core/dist/index.js.map |
| PASS | packages/drift-core/dist/redact.d.ts |
| PASS | packages/drift-core/dist/redact.d.ts.map |
| PASS | packages/drift-core/dist/redact.js |
| PASS | packages/drift-core/dist/redact.js.map |
| PASS | packages/drift-core/dist/store.d.ts |
| PASS | packages/drift-core/dist/store.d.ts.map |
| PASS | packages/drift-core/dist/store.js |
| PASS | packages/drift-core/dist/store.js.map |
| FIXED | packages/drift-core/package.json |
| FIXED | packages/drift-core/src/config.ts |
| PASS | packages/drift-core/src/crypto.ts |
| FIXED | packages/drift-core/src/engine.ts |
| PASS | packages/drift-core/src/errors.ts |
| PASS | packages/drift-core/src/git.ts |
| PASS | packages/drift-core/src/index.ts |
| PASS | packages/drift-core/src/redact.ts |
| PASS | packages/drift-core/src/store.ts |
| PASS | packages/drift-core/tsconfig.json |
| PASS | packages/drift-mcp/dist/index.d.ts |
| PASS | packages/drift-mcp/dist/index.d.ts.map |
| FIXED | packages/drift-mcp/dist/index.js |
| FIXED | packages/drift-mcp/dist/index.js.map |
| FIXED | packages/drift-mcp/package.json |
| FIXED | packages/drift-mcp/src/index.ts |
| PASS | packages/drift-mcp/tsconfig.json |
| PASS | packages/drift-sdk/dist/index.d.ts |
| PASS | packages/drift-sdk/dist/index.d.ts.map |
| PASS | packages/drift-sdk/dist/index.js |
| PASS | packages/drift-sdk/dist/index.js.map |
| PASS | packages/drift-sdk/dist/schema.d.ts |
| PASS | packages/drift-sdk/dist/schema.d.ts.map |
| PASS | packages/drift-sdk/dist/schema.js |
| PASS | packages/drift-sdk/dist/schema.js.map |
| FIXED | packages/drift-sdk/package.json |
| PASS | packages/drift-sdk/src/index.ts |
| PASS | packages/drift-sdk/src/schema.ts |
| PASS | packages/drift-sdk/tsconfig.json |
| PASS | plugin.json |
| PASS | prompts/drift.md |
| PASS | prompts/resolve_merge.md |
| PASS | prompts/review_pr.md |
| PASS | prompts/summarize_intent.md |
| PASS | scripts/acceptance-mvs.sh |
| PASS | scripts/publish-npm.sh |
| PASS | scripts/seed-demo.sh |
| PASS | scripts/verify-app-start.sh |
| PASS | scripts/verify-close-behavior.mjs |
| PASS | scripts/webhook-proxy.sh |
| PASS | SECURITY.md |
| PASS | skills/drift/SKILL.md |
| PASS | tests/app/abort-live.test.mjs |
| PASS | tests/app/app.test.mjs |
| PASS | tests/app/live-server.test.mjs |
| PASS | tests/app/shutdown-live.test.mjs |
| FIXED | tests/integration/pipeline.test.mjs |
| FIXED | tests/mcp/mcp.test.mjs |
| PASS | tests/unit/ast.test.mjs |
| FIXED | tests/unit/config.test.mjs |
| PASS | tests/unit/crypto.test.mjs |
| PASS | tests/unit/encryption.test.mjs |
| PASS | tests/unit/redact.test.mjs |
| PASS | tests/unit/store.test.mjs |
| PASS | tsconfig.base.json |
| PASS | tsconfig.json |

## Defects found

| # | Severity | Defect | Root cause | Fix |
|---|---|---|---|---|
| 1 | Medium | `@drift/cli` `"types"` pointed at `dist/index.d.ts` (never emitted) | package.json edited when only `cli.js`/`cli.d.ts` build outputs exist | `"types": "dist/cli.d.ts"` |
| 2 | Medium | Anthropic `sk-ant-` keys not redacted with default config | pattern present in `redact.ts` but missing from `config.ts` defaults/template | added to `DEFAULT_CONFIG` + `CONFIG_TEMPLATE` |
| 3 | Medium | Corrupted `.drift/drift.db` → generic exit 1 | store open error surfaced without classification | wrapped in `DriftError(..., EXIT.CORRUPT)` → exit 5 with recovery hint |
| 4 | Low | MCP `serverInfo.version` hardcoded `0.1.0` | constant could drift from the release | read from `package.json` via `requireFromHere` |
| 5 | Low | Package versions could drift between packages | manual version bumps | `tests/unit/packaging.test.mjs` enforces root == all packages |

## Regression tests added

- `tests/unit/config.test.mjs`: `sk-ant-` default pattern + real redaction
- `tests/integration/pipeline.test.mjs`: corrupted db → exit 5 corrupt
- `tests/mcp/mcp.test.mjs`: `serverInfo.version` == package version
- `tests/unit/packaging.test.mjs`: types/main/bin targets exist; versions match root

## Verification (real runs)

- `npm test`: 109/109 pass
- `npm run eval`: gate passed (syntaxRejectionRate=1, blameAccuracy=1, replayFidelity=1)
- `scripts/acceptance-mvs.sh`: PRD §4.2 acceptance passed
- CLI E2E (24 checks): init/realize/log/blame/context/verify/replay/doctor/export, exit codes 2/3/4/5, `--json` shapes
- MCP E2E (15 checks): handshake, 6 tools valid + invalid, unknown tool, server stays alive
- Edge+security (20 checks): empty repo, missing git identity, unicode+spaces, binary, 4 MB file, path traversal, orphan detection, redaction, NO_COLOR
- Security (11 checks): agentState redaction, encryption roundtrip + E_KEY, all 10 documented patterns
- action.yml simulated on a Drift repo: log/doctor/verify all structured output
