# Next Steps

Status after the full PRD-execution pass (2026-08-06). The repository is green
and committed. Everything below is **optional follow-up**, not required for a
working build.

## Done in this pass

- **MVS v0.1.0 acceptance (PRD §4.2)** — verified end-to-end on a fresh repo:
  `init → realize → log → blame → verify-intent`, plus syntax gate (exit 2)
  and `E_NO_CHANGES` (exit 3). Fixed `blame --function` to resolve intents
  across the whole function body (was resolving to "baseline" for body-only
  edits). See `scripts/acceptance-mvs.sh`.
- **Eval harness (PRD §22)** — `eval/harness.mjs` + `eval/scenarios/*.json` +
  recorded `eval/baseline.json`; metrics: syntax-rejection 100%, blame
  accuracy 1.0, replay fidelity 1.0; >5% regression gate. `npm run eval`.
- **Tests**: 98/98 green (`npm test`).

## Remaining roadmap (PRD §27, §31)

1. **npm publication** — the only unclosed launch item. `@drift/ast`,
   `@drift/core`, `@drift/cli`, `@drift/mcp` are unpublished (registry 404).
   All manifests already target `npx -y @drift/mcp`; they start working the
   moment the chain is published via `bash scripts/publish-npm.sh` (needs an
   npm login/token on this machine). After publishing: re-run
   `npx -y @drift/mcp handshake` from an empty dir and record the result in
   the README Installation section.
2. **CI workflows** — deliberately not committed (ADR-008; Actions disabled on
   the account). When re-enabled, add `.github/workflows/{ci,release,eval}.yml`
   wrapping `npm test`, `npm run eval`, `scripts/acceptance-mvs.sh`.
3. **Phase 4 (PRD §27)** — `drift merge` (semantic), VS Code blame viewer,
   Homebrew formula, `cargo publish` of a future Rust `drift-ast`.
4. **Launch checklist (PRD §37)** — demo video, HN/X launch draft, GitHub App
   private beta, `examples/demo-repo` re-seeded with fresh intents.
