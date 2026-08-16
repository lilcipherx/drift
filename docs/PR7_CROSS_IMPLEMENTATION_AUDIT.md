# PR #7 — Cross-Implementation Audit

## 1. Starting state (verified 2026-08-16)

- Branch: `fix/privacy-pr-provenance`, HEAD `aedf72e80e8bd62fb0277bd03834643c7bc4834d`
- PR #7: OPEN, mergeStateStatus CLEAN, base `main`, head `fix/privacy-pr-provenance`
- Working tree: only `packages/drift-ast/dist` CRLF noise + untracked scratch files
- Previous pass results (preserved): 201/201 tests, ARM64 + Windows CI success on `aedf72e`

## 2. Defects reproduced

### D1 — Core ↔ Action fingerprint mismatch

- Core `signingKeyIdFor` (packages/drift-core/src/public.ts): SHA-256 of **SPKI DER** bytes.
- Action `signingKeyIdFor` (scripts/pr-comment.mjs): SHA-256 of **trimmed PEM text**.
- Reproduction: a real Core-generated V2 manifest's `signingKeyId` differs from what the Action
  computes for the same key, so `signatureStateFor` classifies a genuinely valid manifest as
  `invalid` (signingKeyId mismatch check).
- Old result: Core-valid manifest reported invalid by the Action.

### D2 — App infers "modified" from presence in base + head

- `auditProvenanceIntegrity` (packages/drift-app/src/intents.ts) marks a manifest `modified`
  when its filename exists in both base and head directory listings — without comparing content.
- Reproduction: base contains manifest A; PR changes only a source file; head still contains A
  → falsely flagged `modified` → failing Check Run on an ordinary PR.
- Old result: false-positive integrity violation on an ordinary PR.

### D3 — Action atomicity gap (added-then-modified)

- Action `auditPublicProvenance` checks the merge-base..head final diff; a manifest added in
  commit A and modified in commit B can still show `A` in the final diff and pass the atomic
  check. The blob is not compared between the introducing commit and PR head.

### D4 — Textual trust-root comparison

- `evaluateKeyChange` (trust.ts) and Action main() use `baseKey.trim() === headKey.trim()` —
  LF/CRLF or whitespace differences of the SAME key register as "replaced".

### D5 — App comment ownership accepts any positive App ID

- `isDriftOwnedComment` accepts `performed_via_github_app.id > 0` without matching the
  configured Drift App ID.

### D6 — Unknown manifest fields silently accepted

- `parsePublicIntentManifest` ignores unknown top-level/nested fields; they are dropped from
  the canonical signed payload view but a manifest containing them still reports `valid`.

### D7 — Index snapshot has no discard/cleanup lifecycle

- `captureIndexSnapshot`/`restoreIndexSnapshot` exist, but there is no explicit
  `discardIndexSnapshot` and no guaranteed finally-cleanup test; successful realize leaves the
  temp backup dir behind until GC.

### D8 — Action never fails on provenance errors

- The composite Action only writes summary/comment; `pr-comment.mjs` exits 0 even for
  invalid/tampered provenance. No `fail-on-provenance-error` input.

## 3. Resolutions (all defects fixed on this branch, verified 2026-08-16)

| # | Defect | Resolution | Regression proof |
|---|--------|-----------|------------------|
| D1 | Core↔Action fingerprint mismatch | Action `signingKeyIdFor` now hashes SPKI DER bytes, exactly mirroring Core; trust-root identity uses the same canonical function | `contract: a real Core V2 manifest is valid through the Action` (tests/unit/pr-comment.test.mjs) — production `PublicStore.write` output classified `valid`, LF/CRLF/whitespace invariant |
| D2 | App presence-based "modified" | `auditProvenanceIntegrity` content-compares base/head blobs; byte-identical ⇒ `unchanged`, different ⇒ `modified` | `handler: ordinary PR with an unchanged historical manifest is NOT flagged as modified` (tests/app/app.test.mjs) |
| D3 | Action added-then-modified gap | After the introduction commit is identified, the head blob is compared byte-for-byte against the introduction blob; `mutated` violation on difference; App mirrors the same semantics | `auditPublicProvenance: added-then-modified in the same PR is a violation (mutated)` (unit) + `auditProvenanceIntegrity: added-then-modified ... (issue 5)` (app) |
| D4 | Textual trust-root comparison | `evaluateKeyChange` (App) and Action main() compare canonical SPKI-DER fingerprints | `evaluateKeyChange` tests + CRLF/whitespace invariance in contract tests |
| D5 | Any-positive-App-ID ownership | `isDriftOwnedComment(comment, expectedAppId)` requires `performed_via_github_app.id === configured App id`; empty/absent App id ⇒ never owned (fail-safe) | `isDriftOwnedComment: requires EXACT configured App id` (tests/app/app.test.mjs) |
| D6 | Unknown fields silently accepted | Core, Action and App validators reject unknown top-level / agent / file fields (V1/V2 field sets enumerated); `symbols` removed from the schema | `strict schema: unknown manifest fields are rejected` (integration) + `validateManifest: strict unknown-field rejection` (unit) |
| D7 | Index snapshot lifecycle | `discardIndexSnapshot` added; realize wraps EVERY post-snapshot operation in a protected try/catch/finally; restore failure yields an actionable combined diagnostic | `index snapshots are always discarded: no drift-idx-* backup survives success, failure, or repeated realizations` (integration, isolated TMPDIR) |
| D8 | Action never fails on provenance errors | `fail-on-provenance-error` input (default true); `hasProvenanceError` policy maps trust/integrity states to exit code; step summary + comment are written BEFORE the non-zero exit | `hasProvenanceError: trust/integrity state → workflow-failure mapping` (unit) |

Additional hardening from the fix plan:

- Raw byte limits before parse: `MANIFEST_MAX_BYTES` (256 KiB, core + Action), App checks byte length before `JSON.parse`; bounded per-PR audit (`MAX_AUDITED_MANIFESTS = 200`, `MAX_TOTAL_PROVENANCE_BYTES_PER_PR = 50 MiB`).
- Atomic introduction in BOTH integrations: the introducing commit must carry exactly one matching `Drift-Intent:` trailer (`intro-mismatch` violation otherwise), the id must not already exist on base (replay), and one id referenced by >1 commit is ambiguous.
- `contract: a real Core V2 manifest is valid through the App` (tests/app/app.test.mjs) — production writer → App loader → `valid`.

Full verification: 212/212 tests, eval gate passed, acceptance gate passed (see final report in the PR).
