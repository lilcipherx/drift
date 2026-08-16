# npm scope decision (release blocker)

Status: **blocked — no package published during this pass.**

## Current package names

All packages are unpublished and use the generic `@drift` scope:

| Package | Current name | Version |
| :--- | :--- | :--- |
| ast | `@drift/ast` | 0.1.1 |
| core | `@drift/core` | 0.1.1 |
| cli | `@drift/cli` | 0.1.1 |
| sdk | `@drift/sdk` | 0.1.1 |
| mcp | `@drift/mcp` | 0.1.1 |
| app | `@drift/app` | 0.1.1 |
| action (metadata only) | `@drift/action` | 0.1.1 |

## Registry observations (read-only `npm view`, 2026-08-16)

| Name | Result |
| :--- | :--- |
| `@drift/cli`, `@drift/core`, `@drift/mcp`, `@drift/ast`, `@drift/app`, `@drift/action` | **404 — not currently published** (not ownership proof) |
| `@lilcipherx/drift`, `@lilcipherx/drift-cli` | **404 — not currently published** |
| `drift` (unscoped) | **taken** — `drift@16.1.0` → `github.com/marketwurks/drift` (unrelated project) |
| `drift-cli` (unscoped) | **taken** — `drift-cli@1.0.6` (unrelated, owner unknown) |

## Ownership

Whether the maintainer controls the `@drift` scope **cannot be verified from
this machine** (no authenticated npm session; `npm whoami` would be required,
and ownership is granted by registry credentials, not by the GitHub account).
An npm 404 means "not published yet", not "the scope is available". The
`@drift` scope is a generic short scope almost certainly **not** controlled by
the `lilcipherx` account.

## Recommended scope

`@lilcipherx` — aligned with the GitHub account (`github.com/lilcipherx`),
consistent with the `@lilcipherx/drift-cli` probe, and currently unclaimed on
the registry. **Verify ownership** with an authenticated `npm whoami` and, if
needed, `npm access` / `npm org` before the first publish.

## Exact files that would need changing

If the scope is switched to `@lilcipherx`:

1. `packages/*/package.json` — `name` fields:
   `@drift/ast` → `@lilcipherx/drift-ast`, `@drift/core` → `@lilcipherx/drift-core`,
   `@drift/cli` → `@lilcipherx/drift-cli`, `@drift/sdk` → `@lilcipherx/drift-sdk`,
   `@drift/mcp` → `@lilcipherx/drift-mcp`, `@drift/app` → `@lilcipherx/drift-app`,
   `@drift/action` → `@lilcipherx/drift-action`.
2. Internal `dependencies` in the same files (`@drift/core` → `@lilcipherx/drift-core`,
   `@drift/ast` → `@lilcipherx/drift-ast`).
3. `scripts/publish-npm.sh` — the `publish_pkg` calls and the `npx -y @drift/mcp`
   handshake.
4. `packages/drift-mcp/src/index.ts` — the installed-CLI lookup
   (`@drift/cli/dist/cli.js` resolution) and `@drift/cli` dependency.
5. `packages/drift-action/package.json` description, `docs/installation.md`
   quickstart (`npm install` examples), `docs/NPM_RELEASE.md` commands,
   `scripts/publish-npm.sh` verification messages.
6. `tests/unit/packaging.test.mjs` — the "internal deps pinned to monorepo
   version" check is name-agnostic; no change needed, but the test globs
   `packages/*` so nothing else is required.

## Migration implications

- The Action runs from a committed checkout (`uses: lilcipherx/drift@<ref>`),
  so a scope rename does not affect the Action itself.
- The MCP server resolves `@drift/cli` at runtime; renaming both packages keeps
  the workspace link working (version pins must stay in sync — covered by
  `tests/unit/packaging.test.mjs`).
- Unscoped `drift` / `drift-cli` are already taken by unrelated projects, so
  the CLI cannot be published unscoped without a suffix.

## Release blocker status

**BLOCKED.** Publishing under `@drift/*` requires proof of scope ownership that
is not available here; publishing unscoped is impossible (`drift` taken). The
recommended path before any release:

1. `npm whoami` with the maintainer account; confirm the `@lilcipherx` scope
   (register it if free: `npm access` / scope claim at npmjs.com).
2. Rename the seven packages + internal deps to `@lilcipherx/*` (files above).
3. Run `npm run build`, `npm test`, `npm run eval`, and the package smoke test.
4. Only then run `bash scripts/publish-npm.sh` (which now has a dry-run and a
   scope-approval preflight — it will refuse to publish otherwise).

No package, tag, or release was created during this pass.
