# Drift — Open-Source Audit

_Date: 2026-08-16 · Machine: Windows 11, Node v24.18.0, npm 11.16.0 · Baseline: `npm test` 111/111, `npm run eval` gate passed._

This audit is the "fresh eyes" pass over the repository before the open-source
push. It records the current architecture, what already works, what is
incomplete, and the recommended priorities. Every claim below was verified by
reading the code and running the commands on this machine — nothing is assumed.

---

## 1. Current architecture

Drift is a **semantic version-control layer over Git**. It wraps `git` (via the
CLI, never touching `.git` internals) and records every commit as an
**Intent**: the prompt that produced the change, the agent/model behind it, the
AST-level mutations, an optional agent-state checkpoint, and an Ed25519
signature — all linked in a SQLite DAG stored in `.drift/`.

```
Agent / Developer
   │  drift realize (CLI) / drift_realize (MCP)
   ▼
┌──────────────────────────────────────────────────────┐
│ drift-cli (Node ≥ 24)                                │
│  ├── drift-ast    syntax check + AST delta           │
│  ├── drift-core   realize/log/blame/verify/replay    │
│  │    ├── SQLite DAG (.drift/drift.db, WAL)          │
│  │    ├── content-addressed objects (.drift/objects) │
│  │    ├── Ed25519 signing + AES-256-GCM encryption   │
│  │    └── secret redaction                           │
│  └── git CLI    stage · commit · blame               │
└──────────────────────────────────────────────────────┘
   │  Drift-Intent: did_… trailer            │ MCP over stdio
   ▼                                        ▼
git history (unchanged semantics)    drift-mcp → AI agents (6 tools)
```

**Packages** (npm workspaces, TypeScript, `tsc -b`, zero native deps):

| Package | Role |
| :--- | :--- |
| `@drift/ast` | Semantic parser (TS/JS + Python): symbol extraction, syntax gate, ADDED/MODIFIED/DELETED/MOVED/RENAMED deltas |
| `@drift/core` | Engine: SQLite intent store, git wrapper, Ed25519 signing, AES-GCM encryption, secret redaction, config |
| `@drift/cli` | The `drift` CLI (`init / realize / log / blame / context / verify / replay / doctor / export / verify-intent / version`) |
| `@drift/sdk` | Typed SDK + Zod intent schemas |
| `@drift/mcp` | MCP server — 6 tools (`drift_realize/context/replay/blame/verify/log`), delegates to the CLI with `--json` |
| `@drift/app` | GitHub App webhook server: reads `Drift-Intent:` trailers, posts idempotent PR summary comments + check runs |
| `@drift/action` | Composite GitHub Action (root `action.yml`) |

**Exit-code contract (PRD §14.1):** 0 OK · 1 error · 2 syntax gate (no commit) ·
3 no changes · 4 encryption key missing/invalid · 5 corrupt store.

**Storage:** `.drift/` = `drift.db` (SQLite DAG, WAL), `objects/<sha2>/<sha>.json`
(content-addressed, signed, gitignored by default), `keys/ed25519.pem` (0600,
gitignored), `config.toml`.

**MCP contract:** the server never touches git/SQLite directly — every tool
spawns the CLI with `--json`; errors are structured JSON, never plain text.

**GitHub App:** `drift-app start` (webhook server, HMAC-verified, 413 on
oversized bodies, graceful shutdown) / `drift-app dev <payload.json>` (one-shot,
`--dry-run`). Comments are **idempotent** via an invisible `<!-- drift:summary -->`
marker (PATCH in place, never stacks).

**CI / release:** no `.github/workflows/` (see §4). Tags exist up to `v0.3.1`;
`CHANGELOG.md` is kept manually (git-cliff style). npm packages are **not yet
published** (registry 404).

## 2. What already works (verified)

- **CLI end-to-end** on fresh temp repos: `init → realize → log → blame →
  context → verify → replay → doctor → export`, plus `verify-intent`. Syntax
  gate returns exit 2 without polluting history; `E_NO_CHANGES` returns exit 3;
  corrupted `drift.db` returns exit 5; missing `DRIFT_MASTER_KEY` with
  encryption enabled returns exit 4.
- **Security primitives:** redaction (AWS/OpenAI/Anthropic/GitHub/Slack/Google/
  Stripe/JWT/PEM) applied to prompt **and** agentState before any storage;
  AES-256-GCM at rest (AAD-bound to intent id, `encv1:` marker, legacy
  plaintext passes through); Ed25519 signatures verified against the object
  file (not DB rows — ADR-007).
- **Path containment:** `blame`/`context` reject `../`, absolute/cross-drive
  paths, and symlink escapes via realpath, before any filesystem read (tested,
  including a live Windows junction test).
- **MCP:** JSON-RPC handshake + all 6 tools, valid/invalid/hostile inputs;
  structured errors; the server survives bad tool calls (no crash).
- **GitHub App:** handler + live webhook server tests (opened/synchronize/
  reopened, no-installation-id, missing objects fallback to commit subject,
  idempotent PATCH, client-abort, graceful shutdown, 413, signature check).
- **Eval harness:** `eval/harness.mjs` + scenarios + baseline gate
  (syntax-rejection 1.0, blame accuracy 1.0, replay fidelity 1.0, >5% gate).
- **Docs:** README (hero, quickstart, per-harness install), `docs/quickstart.md`
  with a **measured** "Verified live" table, `docs/api.md`, `docs/architecture.md`,
  `docs/adrs.md`, SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md (contact:
  lilcipherx), CHANGELOG.md, LICENSE (MIT).
- **Demo:** `examples/demo-repo` committed snapshot + `scripts/seed-demo.sh`
  regenerates it; the demo `blame` output shows a valid signature.
- **Packaging:** `npm pack` of the 4-package chain into an empty dir works;
  handshake answered in ~1 s (measured via tarballs — the exact equivalent of
  the future `npx -y @drift/mcp`).
- **Tests:** 111/111 green; suite covers unit, temp-repo integration, MCP e2e,
  app live-server e2e.

## 3. What is incomplete

1. **No CI.** `.github/workflows/` is absent (ADR-008: committed intentionally
   not — the account's Actions were disabled). The new owner direction is to
   have real CI, so this is the top infrastructure gap.
2. **Prompt storage default.** `drift realize` currently writes the **full
   plaintext prompt as the git commit message** by default
   (`git commit -m "<prompt>\n\nDrift-Intent: <id>"`). For an OSS tool whose
   promise is "the full AI prompt must not automatically land in public
   history", the safe default must be a **summary-only commit message** with
   the full prompt stored only in the local, gitignored `.drift/` store (or not
   at all). There is no configurable prompt-storage mode today.
3. **No `drift status` command** — the first-run UX (Phase 5) wants a friendly
   `status` that explains the repo state and the next step.
4. **GitHub Action is minimal** — it only runs `drift log --json` in CI; it
   does not post the provenance summary on the PR (the GitHub App does, but the
   Action is the zero-setup path for repos that just add a workflow line).
5. **Human `blame` output** is functional but terse (`AGENT @ X`, `model:`,
   `prompt:`, `intent:`, `commit:`); it can be much clearer for the "Why does
   this code exist?" story.
6. **npm publication metadata** — packages lack `repository`/`bugs`/`homepage`/
   `engines`/`keywords`; no `docs/NPM_RELEASE.md` with the exact owner steps.
7. **Issue templates** — only a PR template exists (and it references a stale
   "83 tests" count); no bug/feature templates, no Dependabot config.
8. **Docs drift:** README badge says "110 passing" (now 111); the PR template
   says "83 tests"; `NEXT_STEPS.md`/ADR-008 describe CI as intentionally absent
   (now being added); plugin manifests carry version `0.2.1` while packages are
   `0.1.1`.

## 4. Critical problems

| # | Problem | Impact | Fix |
| :-- | :--- | :--- | :--- |
| C1 | Full prompt in commit message by default | **Privacy**: prompts (often containing product context) land in public git history automatically. Contradicts the project's own promise. | Default `[prompts] mode = "commit-summary"` (see Phase 6): commit carries `Intent:`/`Model:`/`Verification:`/`Drift-Intent:` only; full prompt stays in `.drift` (gitignored) unless `full`/`none` is chosen. |
| C2 | No CI | Contributors cannot see that their PR is green; regressions can slip; OSS reviewers expect a workflow. | Add `.github/workflows/ci.yml` (install → build/typecheck → test → eval → acceptance → pack smoke). |
| C3 | Action posts no PR summary | The one-line-`uses:` experience doesn't deliver the "aha" on GitHub. | Add idempotent PR comment step (Phase 8). |

## 5. Security / privacy concerns

- **Prompt leakage (C1)** is the headline privacy issue — fixed by Phase 6.
- **Redaction is regex-based** — it is defense-in-depth, not a guarantee.
  Documented honestly in SECURITY.md; keep it that way.
- **Encryption at rest** protects `.drift` storage; the **commit message keeps
  the plaintext prompt** in `full` mode — this limitation is documented, but
  with `commit-summary` as the default it no longer applies to new commits.
- **`verifyCmd` executes with the user's shell** — documented in SECURITY.md
  and api.md; only run `verify` on trusted intents. This is a known,
  documented risk (accepted).
- **No telemetry / no network** in the CLI — good. `drift-app` is the only
  networked component and it verifies HMAC signatures, bounds body size, and
  acks client errors as non-retryable.
- The **GitHub App fallback** shows the commit-message subject as the prompt
  when `.drift` objects are missing — with summary-mode commits the fallback
  subject will read `Intent: <summary>`, which is fine (no full-prompt leak).

## 6. Developer-experience problems

- First-run: `drift init` output is good, but there is no `drift status`, and
  `--help` doesn't mention `status` (it doesn't exist yet).
- `blame` human output is hard to parse at a glance (labels are terse).
- README Installation is 11-harness-heavy; the 30-second value story is buried
  under install matrix. Move the matrix to `docs/installation.md`, keep a
  compact table + quickstart in README.
- PR template's test count is stale; the contributing guide is thin on
  conventions, PR flow, and "how to add a new integration".
- Version confusion: plugin manifests (`0.2.1`) vs packages (`0.1.1`) vs
  release tags (`v0.3.1`). Align docs and metadata to one story.

## 7. Recommended priorities

1. **Phase 6 — prompt storage modes (privacy default).** Biggest trust issue
   for OSS adoption; security-sensitive.
2. **Phase 2 — CI.** Contributors need a green check; it also validates the
   eval gate automatically.
3. **Phase 5 — `drift status` + first-run polish.** New-user comprehension.
4. **Phase 8 — Action PR summary.** The zero-setup GitHub experience.
5. **Phase 7 — `blame` "Why / Generated by" output.** The core demo story.
6. **Phase 4 — npm metadata + release guide.**
7. **Phases 3/9/10/11 — contributor docs, README redesign, demo, policies.**

_See the repo roadmap in `NEXT_STEPS.md` and the design records in `docs/adrs.md`._
