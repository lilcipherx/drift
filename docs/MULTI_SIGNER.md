# Multi-signer trust: the keyring (ADR-009 extension)

**Status: implemented and tested on `fix/privacy-pr-provenance` (PR #7).**

Drift's provenance model anchors on a single committed Ed25519 public key
(`.drift/public/key.pem`). For repositories with several maintainers, that
single-signer model is a production blocker: only one person can create new
signed intents, and rotating that key invalidates everything. The **keyring**
extends the model so any number of trusted keys can sign, with a signed,
append-only audit trail of every trust-set change.

## Model

`.drift/public/key.pem` remains the **anchor** and is always present. When the
repository opts in, `.drift/public/keyring.json` (committed) records:

```jsonc
{
  "schemaVersion": 1,
  "keys": [
    {
      "fingerprint": "…16-hex sha256 of SPKI DER…",
      "pem": "-----BEGIN PUBLIC KEY-----…",
      "status": "active",                 // active | revoked | removed
      "addedBy": "<fp>",
      "addedAt": 1724000000000,
      "transitionedBy": null,
      "transitionedAt": null,
      "reason": null                      // rotation | compromise | lost | other
    }
  ],
  "audit": [
    {
      "seq": 1,
      "action": "bootstrap",              // bootstrap | add | revoke | remove
      "fingerprint": "<fp>",
      "by": "<fp>",                       // the authorizing key
      "at": 1724000000000,
      "reason": null,
      "payload": "drift-keyring:v1:1:bootstrap:<fp>:<fp>:<at>:",
      "signature": "<ed25519 base64>"
    }
  ]
}
```

### Trust invariants (a keyring is trusted only when ALL hold)

1. Every key entry is a valid Ed25519 **public** key whose fingerprint is the
   canonical SPKI-DER SHA-256 (never a textual hash — LF/CRLF cannot change an
   identity).
2. The first audit entry is `bootstrap` for the anchor key, and its signature
   verifies against `.drift/public/key.pem` **read from disk** — the anchor
   never comes from the keyring file itself.
3. Audit entries are contiguous (`seq` 1..N) and each verifies against a key
   that was **active immediately before** that entry.
4. Replaying the audit log against an empty state reproduces the `keys` array
   exactly (fingerprints, statuses, order).

Any violation makes the whole trust set **malformed** — fail closed: no
signing, no imports, `keyring list` reports the error, `verify` reports
`unverifiable`. A malformed keyring is a security state, never a cosmetic one.

### Status semantics (state-based trust)

| status   | may sign | may authorize changes | past signatures verify |
|----------|:--------:|:---------------------:|:----------------------:|
| active   | ✅       | ✅                    | ✅                     |
| revoked  | ❌       | ❌                    | ❌ → `untrusted-key`   |
| removed  | ❌       | ❌                    | ❌ → `untrusted-key`   |

Revocation is **state-based**, like a certificate revocation list: a
compromised key can forge anything, so nothing it signed can be trusted
afterward. This matches the pre-keyring single-key behavior (a replaced
`key.pem` invalidates its old signatures) — the keyring's improvement is that
**adding** a key never invalidates anything, and losing one key never
invalidates the whole repository.

## Operations

All commands require an **active** keyring key's private key to be imported
(`drift key import --file <priv.pem>`).

```text
drift keyring init                          # bootstrap from the anchor key (anchor holder only)
drift keyring add --file <pub.pem> [--reason <text>]
drift keyring revoke <fingerprint> [--reason <text>]
drift keyring remove <fingerprint> [--reason <text>]   # requires a DIFFERENT active key
drift keyring list                          # entries + full audit log
```

Rules enforced by the module (and re-verified by replay on every read):

- A key can never add itself.
- A key can revoke itself (`reason: lost`); it cannot remove itself (a second
  active key must authorize rotation cleanup).
- A retired (`removed`) key later found compromised can be upgraded to
  `revoked`.
- Every change is appended to the audit log with `seq = len(audit)+1`; the log
  is append-only.

Keyring files are written atomically (temp + rename) and are **never swept
into a `drift realize` commit**: a tracked `keyring.json` with working-tree
changes refuses `realize` until the change is committed deliberately — the
same rule as `key.pem`.

## Safe rotation procedure

Goal: move signing to a new key without a trust interruption.

1. **Add the new key** — `drift keyring add --file new.pub --reason rotation`.
   Both keys are now active. Commit the keyring deliberately.
2. **Grace period** — both keys stay active (e.g. 30 days), so every
   maintainer can migrate their checkout (`drift key import --file new.priv`).
3. **Remove the old key** — `drift keyring remove <old-fp> --reason rotation`
   (authorized by any other active key). Commit deliberately.
4. **Audit** — `drift keyring list` shows the complete chain
   `bootstrap → add → remove` with timestamps and authorizers.

If the project must keep old signatures verifiable indefinitely, keep the old
key **active** and simply add the new one (step 1 only): additive changes
never invalidate history.

## Key-compromise response

1. **Revoke immediately** — `drift keyring revoke <fp> --reason compromise`.
   From that commit on, the key cannot sign, cannot authorize changes, and no
   manifest it signed verifies (`verify-intent` → `untrusted-key`).
2. **Import can't help the attacker** — the compromised private key no longer
   matches any active key; `key import` and `realize` refuse it.
3. **Audit attribution** — the revoke entry records who revoked it, when, and
   why, so the incident is fully reconstructable.

## Backward compatibility

- No keyring file → the trust set is exactly the anchor key (the legacy
  single-signer model). Nothing changes for existing repositories.
- Legacy V1 manifests (no `signingKeyId`) verify against the anchor only.
- V2 manifests verify against the key named by their `signingKeyId`; in a
  legacy repo that must be the anchor fingerprint (identical behavior to
  before).
- A fresh clone of a keyring repo verifies every manifest via the committed
  keyring without any private key (`verify-intent`, `blame`, `status`).

## Verification behavior

`verify` / `verify-intent` / `blame` resolve the manifest's `signingKeyId`
against the keyring:

| case                                  | result             |
|---------------------------------------|--------------------|
| key active, signature verifies        | `valid`            |
| key active, signature fails           | `invalid`          |
| key revoked / removed                 | `untrusted-key`    |
| key unknown, other keys exist         | `invalid`          |
| no trusted key material at all        | `unverifiable`     |
| keyring malformed (tampered)          | `unverifiable`     |

## PR trust audit: history is append-only

The App (`packages/drift-app/src/trust.ts` + `handler.ts`) and the GitHub
Action (`scripts/pr-comment.mjs`) evaluate the base→head keyring change on
**every PR** (`evaluateKeyringChange`): the ONLY legitimate change is a strict
extension of the audit log (`bootstrap → … → extended`). History attacks fail
the check run and the workflow:

| base → head | verdict |
|---|---|
| absent → valid keyring | `bootstrap` (neutral, visible) |
| identical | `unchanged` |
| base is a strict prefix of head's audit log | `extended` (legitimate add/revoke/remove — does NOT block) |
| head diverges, truncates, or replaces the log with a fresh bootstrap | `replaced` (blocking) |
| head deletes the keyring | `removed` (blocking) |
| malformed head / malformed base | `malformed-*` / `base-malformed` (blocking) |

Deleting a revoke entry, editing an entry, or wiping the history with a new
bootstrap file therefore cannot pass the trust audit — the summary states the
append-only rule explicitly.

## Tests

`tests/integration/keyring.test.mjs` (12 tests):

- backward compatibility (legacy repo untouched, single active key);
- bootstrap (self-signed anchor, idempotent, anchor-holder-only);
- add (new signer active, signs, fresh clone verifies; untrusted keys can't
  authorize; self-add refused);
- compromise (revoke → cannot sign/import/authorize; old signatures
  `untrusted-key`; audit records the reason);
- self-revoke allowed, self-remove refused;
- rotation (grace period both active → remove → complete audit chain);
- tamper (forged entries, fake signatures, payload mismatch, wrong anchor,
  empty file, seq gaps, changes signed by revoked keys — all fail closed);
- malformed committed keyring → CLI refuses imports and init, reports the
  error.
