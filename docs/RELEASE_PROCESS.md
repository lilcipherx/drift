# Release Process

End-to-end procedure for releasing Drift (CLI, MCP, GitHub Action, GitHub
App). npm-specific publishing steps and the scope-ownership blocker are in
[NPM_RELEASE.md](./NPM_RELEASE.md) and [NPM_SCOPE_DECISION.md](./NPM_SCOPE_DECISION.md).
Rollback: [ROLLBACK.md](./ROLLBACK.md).

**No release, tag, or publish happens automatically.** Every step below has an
explicit human approval gate. Publishing during code review is forbidden
unless explicitly authorized by the maintainer.

---

## 1. Release gates (all must be green on the release SHA)

1. Full CI on the final SHA: trusted Linux ARM64 ✓, Windows hosted ✓,
   untrusted Linux fallback correctly skipped ✓, aggregate Linux gate ✓.
2. `npm run build && npm test && npm run eval && bash scripts/acceptance-mvs.sh`
   from a fresh clone.
3. `bash scripts/verify-app-start.sh` (App smoke).
4. Benchmark + soak on the trusted runner (`benchmark` CI job): SLO regression
   gates pass.
5. `npm audit` = 0; secret scan clean; tarball smoke (`npm pack` chain from an
   empty directory) passes.

## 2. Channels

| Channel | Version | Dist-tag | Use |
|---|---|---|---|
| canary | `0.x.0-canary.<sha>` | `canary` | Every trusted push after a stable release; manual dispatch |
| stable | `0.1.0`, `0.1.1`, … | `latest` | Protected manual release |

Canary publishes are the only automated publishes and only after the gates
above; `latest` requires a second explicit human approval.

## 3. Release checklist (stable)

```bash
# 1. Verify the gates (§1) on the release SHA.
# 2. Confirm npm scope ownership (docs/NPM_SCOPE_DECISION.md) with:
npm whoami && npm access ls packages @drift/core   # must show you

# 3. Bump versions (single source: root package.json; packages inherit 0.1.1):
npm version <patch|minor|major> --no-git-tag-version
# update the changelog, then commit + tag:
git tag v0.1.2

# 4. Build + pack-check from an EMPTY directory (tarball smoke):
bash scripts/publish-npm.sh --dry-run

# 5. Publish (explicit approval env; see publish-npm.sh preflight):
DRIFT_NPM_SCOPE_APPROVED=1 bash scripts/publish-npm.sh
```

## 4. Provenance, SBOM, checksums

- **Provenance attestation:** publish from GitHub Actions using npm's
  trusted publishing (OIDC) when the namespace supports it; the attestation
  links the artifact to the release commit. Verify with `npm attest` after
  publishing.
- **SBOM:** generate an SPDX SBOM for the published tarballs
  (`npx @cyclonedx/cyclonedx-npm --omit dev` or equivalent) and attach it to
  the GitHub release.
- **Checksums:** publish `sha256sums.txt` for every tarball in the release.

## 5. Post-publish smoke

```bash
tmp="$(mktemp -d)" && cd "$tmp" && npm init -y >/dev/null
npm install @drift/ast @drift/core @drift/cli @drift/mcp
node_modules/.bin/drift version
node_modules/.bin/drift-mcp version   # MCP starts and handshakes
# fresh-clone provenance flow: clone a repo with .drift/public, drift log works
```

## 6. GitHub Action + App release

- The composite Action ships in this repository (action.yml); release notes
  link the action SHA/tag used by users (`uses: lilcipherx/drift@vX.Y.Z`).
- The App artifact is built from the same release commit and deployed per
  OPERATIONS_RUNBOOK; the App version is surfaced in `/health` for rollback
  correlation.

## 7. Backward compatibility

- Public manifest schema: V1 read-only, V2 current. New fields require a
  versioned, signed extension mechanism (ADR-009) — unknown fields are
  rejected, so releases must NOT add fields to V2 silently.
- CLI stores: SQLite migrations are additive and versioned.
- Downgrades: documented limitations in ROLLBACK.md.

## 8. Support and deprecation

- Support policy: current stable + previous minor. Deprecation: announce in
  release notes at least one minor version before removal; never remove a
  schema version without a migration path.
