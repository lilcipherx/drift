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

### What is public (committed to git)?  - `.drift/config.toml`, `.drift/.gitignore`.


- `.drift/public/key.pem` — the public verification key.
- `.drift/public/intents/<id>.json` — a **PublicIntentView**:

```ts
type PublicIntentView =
  | {
      schemaVersion: 1;   // legacy — read and verified as-is; the `commit`
      id: string;         //   field is treated as UNTRUSTED legacy metadata
      summary: string;    // explicit --summary (redacted → sanitized → truncated)
      commit: string;     //   or a generic non-prompt fallback; NEVER prompt text
      timestamp: number;
      signature: string;
    }
  | {
      schemaVersion: 2;   // current
      id: string;
      summary: string;    // explicit --summary or generic non-prompt fallback
      model?: string;
      agent?: { type: "HUMAN" | "AGENT"; identifier: string };
      verification?: string;  // verify command metadata (shown, not auto-run)
      files?: { path: string; mutationType: string; summary?: string }[];
      timestamp: number;
      signingKeyId: string;   // fingerprint of the signing public key
      signature: string;      // Ed25519 over the canonical public view
      // NOTE: no `commit` field. A manifest cannot sign the SHA of the git
      // commit that contains it (a self-referential cycle). The intent →
      // commit association is derived from the `Drift-Intent:` trailer in
      // the commit message (engine intentCommitIndex), shared by log,
      // context, blame, status, export, the Action and the App.
    };
```

The `summary` is **never derived from the prompt** — the first line of a one-line
prompt would otherwise be copied verbatim into git history. It comes from an
explicit `drift realize --summary "…"` (redacted first, then stripped of control
characters / ANSI escapes, HTML-comment markers and mention-spam tokens, and
truncated to 200 chars) or, when omitted, a generic non-prompt fallback such as
`Drift intent did_abcd1234 (3 files)` built only from the intent id and file count.
In `none` prompt mode the summary is empty unless an explicit `--summary` is given
(nothing derived from the prompt may persist anywhere).

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
  `.drift/public/key.pem` and reports `valid | invalid | unsigned |
  unverifiable` (a regenerated or absent local key never yields a false
  `valid`).
- `drift verify` is **informational by default** (never executes a recorded
  command); `--run` executes only when the manifest is validly signed by the
  repository key, and `--allow-untrusted-command` forces it with a warning.
- `drift replay` and `drift realize` need the private store/keys → clear error:
  "Run `drift init` to create the local intent store."
- `drift export` is **public-only by default** (`containsPrivatePrompts:
  false`); private prompts need `--include-private-prompt`, which warns on
  stderr and refuses to write inside the repository unless
  `--allow-repository-output` is given.

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
   contents API at the PR head). Missing records degrade to a generic
   non-prompt fallback (`Drift intent <id>`) — the commit subject is NEVER
   used as a summary (legacy `full`-mode subjects may contain the whole
   private prompt).
4. Verify each manifest against the **base-branch** `.drift/public/key.pem`;
   a PR that replaces the key is flagged and its provenance marked
   unverified (never silently trusted).
5. Render only `summary` + safe metadata + signature/trust state. `prompt` is
   never rendered, never returned by default JSON, and never posted to a comment.

## Migration of existing repositories

- `drift init` re-runs safely: it merges the required ignore rules into
  `.drift/.gitignore` (never deletes user lines), creates the missing private
  dirs/db, and ensures `.drift/public/key.pem` exists — generating a keypair
  only when neither key exists (State A). It NEVER overwrites an existing
  committed public key.
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
- The public summary is an explicit user-supplied string (or a generic fallback),
  redacted, sanitized and truncated; it is not a substitute for the full prompt
  (which stays local-only by default). Without an explicit `--summary`, the summary
  is deliberately generic so prompt text can never leak into history.
- `none` mode keeps prompts out of everything; public manifests carry a summary only
  when the user explicitly passes `--summary`.
- **Key model (trust root).** `.drift/public/key.pem` is the repository trust
  root. `drift init` in a fresh clone (State C) PRESERVES it byte-for-byte,
  creates only the missing private dirs/db, and enters **read-only signer
  mode** — old signatures stay `valid`, and `drift realize` is refused with an
  actionable message until the matching private key is imported via
  `drift key import --file <path>`. A mismatched local key (State E) fails
  safely and is never used to sign or judged as the trust root. No
  auto-rotation through `drift init`; single-signer rotation is a separate
  controlled operation.
- Fresh-clone `drift blame`/`log` can only show what the public manifest recorded
  (no private agent state, no prompt).
- **`drift realize` is atomic:** source + signed public manifest + key (first
  introduction) + `Drift-Intent:` trailer land in ONE git commit; if the
  commit fails, only the newly generated manifest is removed and the user's
  source stays staged for a retry.
