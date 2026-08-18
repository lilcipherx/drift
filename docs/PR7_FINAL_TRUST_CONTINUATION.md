# PR #7 — Final Trust Continuation

Resumed from the interrupted pass on branch `fix/privacy-pr-provenance`.

## 1. Starting state (verified 2026-08-16)

- Branch: `fix/privacy-pr-provenance` (already pushed to `origin`)
- HEAD: `289ea935909a7ee1947a74a37a14a25cd49d4c58` —
  `docs(ci): record verified ARM64 run for the merge-blocker fix commits (run 31944862922)`
- PR: #7 `fix: secure private provenance and scope PR summaries` — OPEN, unmerged
- Working tree: extensive uncommitted changes (65 files, +3408/−625) plus untracked:
  - `packages/drift-app/src/trust.ts` + `packages/drift-app/dist/trust.*`
  - `scripts/action-run.mjs`
  - `docs/PR7_FINAL_TRUST_AUDIT.md`
  - `.tmp-repro-*.sh` (scratch reproduction scripts)
- Baseline: `npm run build` clean; `npm test` → 182 passed / 0 failed
- No staged changes (`git diff --cached` empty); index holds no Drift staging

## 2. Interrupted work already present (verified by inspection)

- Strict versioned public-manifest validator in `packages/drift-core/src/public.ts`
  (byte-size bound 256 KiB, field limits, ID↔filename match, V2 `signingKeyId`
  syntax, bounded diagnostics).
- Malformed-manifest diagnostics surfaced by `log`/`status`/`export`/`verify`
  (`malformed` signature state, never silent "missing").
- Sanitized `drift verify --run` environment (allowlist +
  secret-denylist, `--inherit-env` opt-in).
- Git index snapshot/restore around `realize` failures (patch-replay based —
  see §3 for the required upgrade) and config staging only when safe.
- Action: v2 marker comment, ownership-verified upsert, trust-root-first
  evaluation, step-summary-before-token, safe `action-run.mjs` launcher with
  allowlist + tokenizer.
- App: `trust.ts` conclusion policy, bootstrap semantics, key-only PR
  handling, webhook fail-closed, comment ownership.

## 3. Remaining work in this pass (from the instruction set)

1. Reject empty public summaries (V2 must be non-empty; `none` mode uses the
   generic non-prompt fallback instead of `""`).
2. Canonical key fingerprint from SPKI DER (not textual PEM hashing).
3. Public-provenance change detection in the PR: append-only rules, orphan /
   replay / ambiguous / modified / deleted / renamed detection, atomic
   manifest+trailer association.
4. Byte-for-byte Git index snapshot/restore (replaces patch replay) +
   unmerged-index refusal.
5. Do not auto-stage unrelated config edits; refuse signing when a tracked
   public key is unexpectedly modified.
6. Check Runs independent of comments; Action comment pagination via Link
   header; distinct `action-summary:v2` / `app-summary:v2` markers with
   ownership scoping.
7. Webhook HMAC before JSON parsing at the server boundary (verify + tests).
8. Broaden secret-env deny patterns (`AWS_*` prefix etc.).
9. New regression tests; full gate; focused commits; push; PR #7 body update;
   fresh ARM64 + Windows CI on the final SHA.
