# PR #7 — Merge-blocker baseline

Recorded before any production change in this repair pass.

## Starting state

- Branch: `fix/privacy-pr-provenance`
- HEAD: `ed6e235` (docs(ci): record verified ARM64 self-hosted run)
- Working tree: clean
- PR: https://github.com/lilcipherx/drift/pull/7 (OPEN, into `main`)
- CI (run 31941242584): `test (Linux ARM64, node 24)` SUCCESS on the Oracle
  Cloud ARM64 self-hosted runner, `test (Windows, node 24)` SUCCESS, fork
  fallback job SKIPPED (same-repo PR, by design).
- Local suite: 147 tests passing, eval + acceptance passing (recorded in the
  prior pass and reproduced at HEAD before this pass).

## Reproduction method

Every blocker was reproduced by running the real built CLI / Action script
(`packages/drift-cli/dist/cli.js`, `scripts/pr-comment.mjs`) in throwaway git
repositories under a temp dir. Host: Windows/x64 (Git Bash). No repo files were
modified by the reproductions.

## Blocker A — `drift realize` does not commit the public manifest

Exact reproduction:

```bash
git init -b main && drift init
# create src.ts, commit baseline
drift realize -p "improve retry handling" --summary "Improve retry handling"
git ls-tree -r --name-only HEAD
git ls-files .drift/public/intents | wc -l
ls .drift/public/intents | wc -l
```

Observed:

- `HEAD` contains only `src.ts` — no `.drift/public/` files.
- 0 manifest files tracked; 1 manifest file exists on disk (untracked).
- The `Drift-Intent:` trailer IS present in the commit.

Root cause: `engine.ts realize()` runs `git commit` (line ~538) and only then
writes `.drift/public/intents/<id>.json`. The manifest is never staged or
committed, so a normal user flow ships a commit with a `Drift-Intent:` trailer
that no public manifest can resolve. Every downstream consumer (log, blame,
Action, App, fresh clones) is starved of canonical provenance unless the user
manually runs a second `git add . && git commit`.

## Blocker B — `drift init` replaces the repository trust root in a clone

Exact reproduction:

```bash
repo A: git init -b main, drift init, realize an intent
push A to a bare remote (default branch main)
clone into B
sha256sum .drift/public/key.pem        # before init
drift init
sha256sum .drift/public/key.pem        # after init
```

Observed:

- key sha256 before init: `bed4de86805af6b3fbfcc6894d0a3bbfd634e51fdbdf699af53f96c488daf852`
- key sha256 after init:  `a5593af87c29205e5c92984a4d55f07fd5817192f7e434fc382c0f200661d2e8`
- Key is REPLACED by init. `git status --short` shows `?? .drift/` — the whole
  `.drift/` directory is untracked because Blocker A prevented public
  provenance from ever being committed.

Root cause: `Drift.init` generates a brand-new keypair whenever
`.drift/keys/ed25519.pem` is absent and unconditionally calls
`publicStore.writePublicKey(...)`, silently replacing the committed public
trust root. (In this reproduction the replace was masked by Blocker A — the
public key was never committed in the first place; the two defects compound.)

## Blocker C — default `drift export` exposes private prompts

Exact reproduction:

```bash
drift realize -p "add DRIFT_EXPORT_PRIVATE_SECRET_6c91 ..." --summary "Export test"
drift export
```

Observed: the default export stdout contains `DRIFT_EXPORT_PRIVATE_SECRET_6c91`.
`exportJson()` in engine.ts serializes `prompt: this.decryptText(e.prompt, e.id)`
whenever a local store exists, with no flag guarding it.

## Blocker D — Action/App fall back to the commit subject

Exact reproduction:

```bash
# commit with subject DRIFT_LEGACY_SUBJECT_SECRET_b8e4 and a valid
# Drift-Intent: did_0000...0001 trailer, but NO public manifest
import { intentsFromCommits } from 'scripts/pr-comment.mjs'
intentsFromCommits({ repoRoot, commits: ['HEAD'], gitImpl })
```

Observed: `[{ "id": "did_0000...0001", "summary": "DRIFT_LEGACY_SUBJECT_SECRET_b8e4" }]`
— the raw commit subject (which may contain a full prompt in legacy
`full`-mode commits) is rendered as the public summary.

Root cause: `pr-comment.mjs` line ~221 `manifest?.summary ?? fromCommit?.subject`
and `drift-app/src/intents.ts` `manifest?.summary ?? subjectByIntent.get(id)`.

## Blocker E — informational `drift verify` executes repository code

Exact reproduction:

```bash
drift realize -p "verify test" --summary "Verify test" --verify-cmd "touch $MARKER"
drift verify <intent-id>      # plain, informational
test -f $MARKER
```

Observed: the marker file EXISTS after the plain informational `drift verify`.
`engine.ts verify()` unconditionally `spawnSync(verifyCmd, { shell: true })`.
A repository-provided verification string is executed merely by listing
provenance.

## Baseline test results (pre-change)

- `npm run build` — exit 0 (clean)
- `npm test` — 147 passing (recorded prior pass; not re-run in this pass before
  changes because the reproductions above already confirm the defects at HEAD;
  the full suite is re-run after the fix).
