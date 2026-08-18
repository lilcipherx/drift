# Rollback

Down-level and undo procedures for every releaseable surface. Companion:
[RELEASE_PROCESS.md](./RELEASE_PROCESS.md), [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md).

---

## 1. npm packages

| Action | Procedure |
|---|---|
| Rollback a bad `latest` | 1) Publish the previous good version to `latest` (never `npm unpublish` a version others may have installed — unpublish is only for truly unpublished, unpulled artifacts within the 72 h window and never for a version already in use). 2) Keep the bad version available; document it as deprecated. |
| Canary rollback | Point the `canary` dist-tag at the previous good build. |
| Users on a broken version | Downgrade: `npm install @drift/cli@<good-version>`; CLI store is backward-compatible (additive migrations). |

## 2. GitHub App

| Action | Procedure |
|---|---|
| Rollback an App deploy | Redeploy the previous artifact (stateless replicas; queue DB is shared/co-located and schema-compatible — see below). |
| Webhook secret / key rotation after compromise | Set a new secret/key on all replicas and the GitHub App settings; restart; redeliver a test delivery. |
| Queue schema incompatibility | SQLite queue schema is additive; if a deploy introduces a breaking queue migration, roll back the APP first (queue files are never migrated by the old version — verify with `/ready` before and after). |

## 3. Schema and data

| Surface | Downgrade behavior |
|---|---|
| Public manifests | V1 read-only; V2 current. An older CLI reads V2 manifests as-is but never validates fields it doesn't know (strict parser rejects unknown fields — a NEWER manifest with an extension field is `malformed` to an older CLI by design). |
| CLI private store | `drift.db` schema is additive; an older CLI opens a newer DB only if no unknown columns are required — check `drift doctor` after downgrade. |
| Index | Stat-validated and versioned; an older CLI with a different index version drops and rebuilds it. |
| Git provenance | Manifests + trailers are committed atomically; git history is the source of truth and never rewritten by Drift. |

## 4. Keys

| Action | Procedure |
|---|---|
| Rotate signing key | Explicit single-signer rotation (ADR-009): keep the old public key verifiable during transition, import the new key, re-sign only if the design requires; multi-signer keyring is the planned extension. |
| Restore a lost key | No recovery without a backup (key backup is operator responsibility). Without it: read-only signer mode + explicit re-key (existing signatures stay valid under the OLD key; document which key signed what). |

## 5. Limitations (explicit)

- **No automatic rollback.** Every procedure requires a human; the release
  process has a protected manual approval gate.
- **npm unpublish is not a rollback tool** for published-and-used versions.
- **Downgrade across a manifest-schema boundary** (future V3) is unsupported;
  the schema is additive and versioned by design to avoid this.
- **Queue redelivery after rollback** is safe (delivery-id dedupe) but may
  replay Check Runs — idempotent by design.
