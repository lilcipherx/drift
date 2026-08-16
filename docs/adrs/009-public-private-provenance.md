# ADR-009: Public/private provenance separation

**Status:** Accepted (this branch).

## Problem

Drift mixed three things in one `.drift` tree:

1. **Private local data** — `drift.db` (full prompts), `objects/` (content-addressed
   intent records that embed the full redacted prompt), `keys/` (the signing key).
2. **Public provenance** — the `Drift-Intent:` git trailer, commit subjects.
3. **Integration inputs** — the GitHub Action ran `drift log --json --limit 20`
   (repo-wide, not PR-scoped) and rendered `intent.prompt`; the GitHub App hydrated
   intents from `.drift/objects/**` at the PR head and rendered `intent.prompt`.

`drift init` wrote a `.drift/.gitignore` containing only `keys/`, so `git add .`
staged `drift.db` and the prompt-bearing object files. The demo repository shipped
all of them **tracked in git**. The documented claim that "the full prompt never
enters git history automatically" was false.

## Decision

**Public signed manifests are the canonical public provenance source (Option B).**

```
.drift/
├── .gitignore          # committed — ignores everything except the allow-list
├── config.toml         # committed (unchanged)
├── public/             # committed — the ONLY trackable Drift data
│   ├── key.pem         #   Ed25519 public key (idempotent, written by drift init)
│   └── intents/<id>.json  # signed PublicIntentView per intent
├── drift.db            # private — ignored (kept at the legacy path)
├── objects/            # private — ignored (legacy content-addressed records)
├── keys/               # private — ignored
└── private/            # reserved for future private state (ignored)
```

`.drift/.gitignore` (Drift-owned, merged idempotently by `drift init`):

```gitignore
*
!.gitignore
!config.toml
!public/
!public/**
```

Verified empirically with `git check-ignore` / `git add -A`: `drift.db`,
`objects/**`, `keys/**`, `private/**` are ignored; `config.toml`, `.gitignore`,
`public/**` are trackable. `git add .` can never stage private Drift data.

### What is private?

- The raw and full redacted prompt (local `drift.db`, legacy `objects/`).
- `agentState`, the Ed25519 private key, the SQLite database.
- Anything under `.drift/private/`.

### What is public (committed to git)?

- `.drift/config.toml`, `.drift/.gitignore`.
- `.drift/public/key.pem` — the public verification key.
- `.drift/public/intents/<id>.json` — a **PublicIntentView**:

```ts
type PublicIntentView = {
  schemaVersion: 1;
  id: string;
  summary: string;        // redacted → sanitized → truncated (500 chars)
  model?: string;
  agent?: { type: "HUMAN" | "AGENT"; identifier: string };
  verification?: string;  // verify command metadata
  files?: { path: string; mutationType: string; summary?: string }[];
  commit: string;         // git sha of the intent's commit
  timestamp: number;
  signature: string;      // Ed25519 over the canonical public view
};
```

The `summary` is derived **only** from the already-redacted prompt, then stripped of
control characters / ANSI escapes, HTML-comment markers and mention-spam tokens, and
truncated. In `none` prompt mode the summary is empty (nothing derived from the
prompt may persist anywhere).

### Why Option B over Option A (trailers)?

Trailers carry only the intent ID. The Action and App need summary, model, files and
verification metadata to render a useful PR comment; with Option A they would have to
re-derive every field from commit bodies (fragile, or impossible for `none` mode) or
fall back to the private DB (unavailable after a fresh clone). Public manifests keep
everything the integrations need in one committed, signed, machine-readable source —
the smallest safe change to the existing architecture, which already wrote intent
objects to `.drift/`.

## Fresh-clone behavior

After `git clone`, `.drift/` exists with `config.toml` + `public/` but **no**
`drift.db`. Read commands detect this and serve from the public manifests:

- `drift log` → intents from `.drift/public/intents/` (id, summary, agent, model,
  verification, files, commit, timestamp).
- `drift blame` → `git blame` sha → public manifest lookup by `commit`; a line with
  no manifest record is the normal "pre-Drift baseline".
- `drift status` → `initialized: true`, counts from manifests, prompt mode from
  `config.toml`.
- `drift verify-intent` → verifies the manifest signature with
  `.drift/public/key.pem`.
- `drift verify` (re-runs the recorded command) works from manifest metadata.
- `drift replay` and `drift realize` need the private store/keys → clear error:
  "Run `drift init` to create the local intent store."

It is acceptable to say "Private prompt: unavailable in this clone"; it is never
acceptable to crash because the private database is missing.

## Signature behavior

- Locally, intent signatures keep verifying against the legacy object file
  (ADR-007 unchanged).
- Public manifests carry their own Ed25519 signature over the canonical public view,
  verifiable with the committed `.drift/public/key.pem` — so a fresh clone can still
  verify provenance without any private data.
- The private key never leaves `.drift/keys/` and is never committed.

## Data used by the GitHub Action and GitHub App

Both integrations switch to the same canonical source:

1. Select **only the current PR's commits** (immutable base/head SHAs via
   `git merge-base` + `git rev-list`), never the last N repo-wide intents.
2. Parse `Drift-Intent: <id>` trailers from those commits' messages with a
   git-trailer-aligned parser (not substring search).
3. Load `.drift/public/intents/<id>.json` (Action: from the checkout; App: via the
   contents API at the PR head). Missing records degrade to the commit subject.
4. Render only `summary` + safe metadata. `prompt` is never rendered, never
   returned by default JSON, and never posted to a comment.

## Migration of existing repositories

- `drift init` re-runs safely: it merges the required ignore rules into
  `.drift/.gitignore` (never deletes user lines), writes `.drift/public/key.pem` and
  the `public/intents/` directory.
- `drift realize` starts writing public manifests alongside the existing private
  records; the DB and `objects/` stay where they are (backward compatible).
- `drift doctor` gains checks that report whether private files are ignored, whether
  private files are **already tracked**, and whether the repo contains legacy
  prompt-bearing tracked objects — with the exact safe commands to untrack them
  (`git rm --cached ...`) and a warning that untracking does not purge old history.
  Doctor never runs destructive commands itself.
- No git history is rewritten.

## Limitations

- Removing files from the index does not remove them from old commits; repositories
  that already committed prompts must treat that history as exposed and rotate
  affected secrets.
- The public summary is derived from the redacted prompt and truncated; it is not a
  substitute for the full prompt (which stays local-only by default).
- `none` mode keeps prompts out of everything, but public manifests then carry no
  summary.
- Fresh-clone `drift blame`/`log` can only show what the public manifest recorded
  (no private agent state, no prompt).
