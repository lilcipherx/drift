# Next Steps

Status after the OSS-readiness pass (2026-08-16). The repository is green and
committed. Everything below is **optional follow-up**, not required for a
working build.

## Done in this pass

- **MVS v0.1.0 acceptance (PRD §4.2)** — verified end-to-end on a fresh repo:
  `init → realize → log → blame → verify-intent`, plus syntax gate (exit 2)
  and `E_NO_CHANGES` (exit 3). See `scripts/acceptance-mvs.sh`.
- **Eval harness (PRD §22)** — `eval/harness.mjs` + `eval/scenarios/*.json` +
  recorded `eval/baseline.json`; metrics: syntax-rejection 100%, blame
  accuracy 1.0, replay fidelity 1.0; >5% regression gate. `npm run eval`.
- **Prompt storage modes** — `[prompts] mode` (commit-summary default / full /
  none) keeps the full prompt out of public git history by default; `drift
  status` for first-run orientation; human `blame` now explains Why / Generated
  by / Verification / Intent / Commit.
- **CI** — `.github/workflows/ci.yml` committed (ubuntu + windows × Node 24:
  npm ci → build/typecheck → test → eval → acceptance → pack smoke). The
  Action also posts an idempotent PR summary comment (`comment: true`).
- **Contributor onboarding** — CONTRIBUTING.md rewrite, bug/feature issue
  templates, `docs/GOOD_FIRST_ISSUES.md` (12 tasks), README redesign +
  `docs/installation.md`, publication metadata + `docs/NPM_RELEASE.md`.
- **Tests**: 123/123 green (`npm test`).

## Remaining roadmap

1. **npm publication** — the only unclosed launch item. `@drift/ast`,
   `@drift/core`, `@drift/cli`, `@drift/mcp` are unpublished (registry 404).
   Follow `docs/NPM_RELEASE.md` and `bash scripts/publish-npm.sh` (needs an
   npm login/token). After publishing: move the npx commands back to first
   position in README + every manifest, and record the live npx measurement
   in the quickstart's "Verified live" table.
2. **First release with the new defaults** — cut a version that ships the
   summary-only commit messages (v0.4.0+), re-seed `examples/demo-repo` with
   the fresh format, and refresh the release notes.
3. **Phase 4 (PRD §27)** — `drift merge` (semantic), VS Code blame viewer,
   Homebrew formula, `cargo publish` of a future Rust `drift-ast`.
4. **Launch checklist (PRD §37)** — demo video, HN/X launch draft, GitHub App
   private beta.
