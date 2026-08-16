# Privacy / Action Repair — Baseline (pre-change)

Recorded before any change on branch `fix/privacy-pr-provenance`.

## Repository state

| Item | Value |
| :--- | :--- |
| Starting branch | `main` |
| Starting commit | `26d750b99ddaf818b95f9c94524e588a5767621e` |
| Worktree | clean |
| Remote | `origin https://github.com/lilcipherx/drift.git` (fetch + push) |
| Node | `>= 24` (repo engines), `node:sqlite` + `node:crypto` |

## Commands executed (exit codes are real)

| Command | Exit | Result |
| :--- | :--- | :--- |
| `npm ci --no-audit --no-fund` | 0 | 103 packages installed |
| `npm run build` (`tsc -b`) | 0 | clean |
| `npm test` | 0 | **123 tests, 123 pass, 0 fail** (`tests 123 / suites 2 / pass 123 / fail 0 / skipped 0`, duration ~32s) |
| `npm run eval` | 0 | scenario suite + regression gate `passed: true` |
| `bash scripts/acceptance-mvs.sh` | 0 | MVS acceptance flow prints expected exit codes (syntax gate 2, no-changes 3) |

The earlier report's claim of **123/123 tests passing** is reproduced exactly.

## Existing prompt-leakage findings (pre-change)

| Surface | Finding |
| :--- | :--- |
| `.drift/.gitignore` created by `drift init` | contains only `keys/` → `drift.db`, `objects/`, `private/` are **not** ignored |
| `git add .` in a Drift repo | stages `.drift/drift.db` and `.drift/objects/*.json` |
| Intent object JSON (`.drift/objects/<sha>/<sha>.json`) | stores the **full redacted prompt** in `prompt`, plus `agentState`, `verifyCmd` |
| `examples/demo-repo` | `drift.db` + 3 object JSONs (full prompts) **tracked in Git** |
| `drift log --json` | returns `prompt` (full local prompt) by default |
| `drift blame --json` | returns full `intent` object including `prompt` by default |
| `drift status --json` | `lastIntent.prompt` (full prompt) |
| `drift context --json` | full prompts by default |
| `drift export` | full local prompts (explicit command) |
| `scripts/pr-comment.mjs` (Action) | runs `drift log --json --limit 20` = **last 20 repo-wide intents**, not PR-scoped; renders `intent.prompt` in the PR comment |
| `packages/drift-app` (GitHub App) | loads `.drift/objects/**` from the repo tree (private objects expected committed); renders `intent.prompt` in the comment/check-run |
| `scripts/seed-demo.sh` | `git add -f .drift` — commits DB, objects **and keys** |
| Docs | `docs/architecture.md` claims "the full prompt never enters git history automatically" — false while objects/DB are trackable |
| `docs/installation.md` | `uses: lilcipherx/drift@v0.3.1` (tag may not contain documented inputs) |
| README badges | static `tests-123 passing-brightgreen` and `CI-GitHub Actions-blue` badges (not real CI status) |
| `docs/NPM_RELEASE.md` / `docs/RELEASE_READINESS.md` | reference `v0.4.0` as a future release (tag does not exist) |

## Files tracked under `.drift` (pre-change)

```text
examples/demo-repo/.drift/.gitignore
examples/demo-repo/.drift/config.toml
examples/demo-repo/.drift/drift.db
examples/demo-repo/.drift/objects/47/f580dbb64b66e929a8e5a5b0c4a5e0b9a9c33ccbe3e55c7509aac803cc6c11.json
examples/demo-repo/.drift/objects/53/c7f2e2401162ad712c6d6ce1cf3c42aa8ffd36574ae9bc9ffaea253b2f0ea3.json
examples/demo-repo/.drift/objects/d5/a35fd199a852127f2a6ef22f5a2b1a08aa05912340da0ded14d4f46b9c574f.json
```

## Full prompt data in tracked files?

**Yes.** `git grep '"prompt"' -- examples/demo-repo/.drift` matches all three object JSONs; each contains a
`"prompt"` field with the full (redacted) prompt text. `drift.db` also stores prompts in its `intents` table.
Demo keys are present on disk under `examples/demo-repo/.drift/keys/` but ignored via the root `.gitignore`.

## GitHub Actions visibility

Not verified from this machine at baseline time (`gh` auth status checked later in this pass). No claim of a
public CI run is made from this document.
