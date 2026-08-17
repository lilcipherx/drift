# Production Readiness Audit

**Status: maintained continuously on the hardening branch `fix/privacy-pr-provenance` (PR #7).**
**Companion: [PRODUCTION_READINESS_REPORT.md](./PRODUCTION_READINESS_REPORT.md) — final GO/NO-GO decision.**

This document is the working audit: architecture map, data-flow map, trust
boundaries, public/private data surfaces, test and CI state, the risk
register, bottlenecks, release blockers, and operational gaps. Every claim is
tied to reproducible evidence (tests, benchmarks, workflows, docs).

---

## 1. Baseline

| Item | Value |
|---|---|
| Starting SHA (this hardening effort) | `99b8bc3` |
| Branch | `fix/privacy-pr-provenance` |
| PR | #7 (open, never merged) |
| Original tests | 280 unit/integration/MCP tests passing |
| Original CI | Linux ARM64 self-hosted + Linux x64 fallback + Windows, all green |
| Reproduced Critical/High defects | See §5 (queued-path HMAC loss, 403-secondary-rate-limit misclassification, bounded-command O(N) manifest walks) |

## 2. Architecture map

```
                    ┌────────────────────────────────────────────────────┐
                    │                    GitHub                          │
                    │  App installation events · PR metadata · contents │
                    └───────────────┬────────────────┬──────────────────┘
                                    │ webhook (HMAC) │ REST (App JWT → install token)
                                    ▼                ▼
┌──────────────────────────┐  ┌───────────────────────────────────────────┐
│ drift-core (pure library)│  │ drift-app (GitHub App)                    │
│  engine · store (SQLite) │  │  POST /webhook → HMAC → idempotency (X-   │
│  trust-root · crypto     │  │  GitHub-Delivery) → durable queue → worker │
│  public manifests (V2)   │  │  (re-verifies HMAC, bounded concurrency,   │
│  stat-validated index    │  │  lease, retry w/ backoff+Retry-After) →    │
│                          │  │  audit → Check Run + owned comment        │
└──────────┬───────────────┘  └───────────────────────────────────────────┘
           │ @drift/* workspace packages
           ▼
┌──────────────────────────┐  ┌───────────────────────────────────────────┐
│ drift-cli (bin `drift`)  │  │ drift-mcp (bin `drift-mcp`)               │
│  init · realize · log ·  │  │  MCP server exposing the same Core        │
│  status · context · blame│  │  trust states                              │
│  verify · export · doctor│  └───────────────────────────────────────────┘
└──────────────────────────┘
           ▲
           │ GitHub Action (composite, mirrors the same strict parser +
           │ association semantics in scripts/pr-comment.mjs)
```

- **drift-core** — zero-dependency (Node built-ins only) provenance engine.
  SQLite (`node:sqlite`) private store; strict V2 public-manifest schema;
  Ed25519 signatures; atomic commit+trailer writes; the stat-validated
  public-manifest index keeps bounded commands O(limit) in memory.
- **drift-cli / drift-mcp / Action / App** — four consumers of the SAME Core
  trust semantics; the Action additionally mirrors the strict trust-root
  parser and association rules in `scripts/pr-comment.mjs` (shared contract
  fixtures in eval/).
- **drift-app** — Node HTTP webhook server + durable worker. Production queue
  adapter is SQLite (single-node; see release blockers §8).

## 3. Data-flow map

### Realize (CLI, local)
```
prompt → [AES-256-GCM at rest optional] → private store (SQLite, .gitignored)
       → public manifest (V2, strict schema) + Drift-Intent trailer
       → SINGLE atomic git commit (source + manifest + trailer)
       → failure: exact index restore, no partial state
```

### Webhook (App)
```
GitHub delivery → bounded body → HMAC verify (fail closed) →
X-GitHub-Delivery idempotency → durable enqueue (202 fast) →
worker: HMAC re-verify over stored raw body → PR snapshot consistency guard
(stale skip) → trust-root change evaluation (base vs head key) →
commit enumeration w/ completeness proof → changed-files audit (append-only,
bounded per-PR limits) → manifest hydration + per-intent signature states →
Check Run (primary) + ownership-verified comment → ack/retry/dead-letter.
```

### Verify (CLI)
```
manifest file → bounded size → strict schema → canonical JSON →
Ed25519 verify against base trust root → trust state (valid/invalid/…)
```

## 4. Trust boundaries

| Boundary | Rule |
|---|---|
| Repository content (manifests, trailers, git history) | Untrusted input; strict schema; never rendered raw; bounded sizes; fail-closed integrity |
| Webhook endpoint | HMAC-required (fail closed); no secret → refuse unless explicit dev mode |
| Queue DB | Trusted local store, but jobs carry the verified signature and the worker RE-verifies it (forgery-in-DB cannot produce an audit) |
| Local store (`drift.db`, `objects/`) | Private; optional encryption; never read by App/Action/MCP; never rendered |
| Trust root (`.drift/public/key.pem`) | Strict Ed25519-only parser; canonical SPKI identity; base-branch key is the verification key; PR key replacement = detected failure state |
| Manifest index | Selection/ordering cache ONLY; every displayed entry is re-read and re-validated from the file; status/doctor always re-verify the full tree |
| Runner/CI | Persistent self-hosted ARM64 runner only for trusted human same-repo PRs (exact De Morgan routing); untrusted PRs validated on ephemeral hosted runners; all actions SHA-pinned |

## 5. Correctness/security defect register (reproduced + fixed)

| Severity | Defect | Root cause | Fix | Regression test |
|---|---|---|---|---|
| Critical | Queued App deliveries never audited with a secret configured | Worker rebuilt the event without the signature; handler rejected every authenticated job as "invalid webhook signature" | Persist the verified signature on the job; worker re-verifies the HMAC before auditing | `tests/app/server-queue.test.mjs` "full queued path" |
| High | GitHub secondary rate limit (403+Retry-After) dropped deliveries permanently | Handler classified any 403 as permanent; the client's transient `RateLimitError` was ignored | `RateLimitError` → retryable; client Retry-After becomes the worker backoff floor | `tests/app/worker.test.mjs` "secondary rate limit" |
| High | `log --limit N`/`context` loaded and parsed EVERY manifest | Bounded command, unbounded work (O(N) parse per command) | Stat-validated manifest index (selection only; re-read on display; schema versioned; fresh-clone heap fallback) | `tests/unit/bounded-index.test.mjs` (12 tests incl. rebase, tamper, parallel, crash) |
| Medium | `log`'s diagnostics re-walked every manifest | Full parse for warnings on a bounded command | Index tracks invalid ids; only those files re-read; full walk fallback | `tests/unit/bounded-index.test.mjs` |

Additional hardening this effort: CI benchmark gates (100k manifest cold
path, intake load, worker soak, full e2e fault scenarios), SHA-pinned
actions, secret/license/tarball/SBOM gates, docs-command test.

## 6. Test and CI state (latest local run)

| Gate | Result |
|---|---|
| `npm test` | 335/335 pass |
| `npm run eval` | gate passes |
| `bash scripts/acceptance-mvs.sh` | passes |
| docs-command test | passes |
| App intake benchmark | ~899 deliveries/s, p99 ≈ 44 ms |
| App e2e benchmark (7 fault scenarios) | all pass, zero dead letters |
| Worker soak (10k jobs + duplicates) | drains, 0 data loss |
| Secret scan / license review / tarball scan / SBOM | clean |
| 100k-manifest CLI benchmark | see PERFORMANCE_REPORT.md |

## 7. CI topology (final)

- `test-linux-arm64` — Oracle Ubuntu 24.04 ARM64 self-hosted (trusted PRs/pushes only).
- `test-linux-untrusted` — hosted x64, exact De Morgan negation.
- `test-linux` — aggregate gate: exactly one of the two ran.
- `test-windows` — hosted.
- `benchmark` — large-repo (20k + 100k), App intake, e2e, soak (protected pushes).
- `security.yml` — CodeQL, dependency review, npm audit, secrets/licenses/
  tarballs/SBOM, SHA-pinning + permissions self-audit.
- `soak.yml` — nightly 3k-job soak on the self-hosted runner.

## 8. Release blockers (see PRODUCTION_READINESS_REPORT.md)

1. **Production shared durable queue/storage adapter** — IMPLEMENTED
   (`PostgresQueue`, async `QueueAdapter` contract, `DRIFT_APP_QUEUE=postgres`
   + `DRIFT_QUEUE_URL`), with unit tests for multi-instance claim safety and
   a dedicated CI job (`queue-postgres`) running the full suite, the e2e
   fault scenarios (incl. multi-instance), and the soak against a real
   Postgres 16 service container. Status: verification evidence comes from
   the CI run on the final SHA.
2. **Multi-signer/keyring** — RESOLVED. `docs/MULTI_SIGNER.md`; the signed,
   append-only keyring (`keyring.json`) supports bootstrap/add/revoke/remove
   with a full audit trail, backward compatibility, and fail-closed tamper
   detection; 11 tests in `tests/integration/keyring.test.mjs` including key
   compromise scenarios.

## 9. Performance/scalability bottlenecks (measured)

- Cold index build is O(N) stat+parse once per change (unavoidable, ~12 s at
  100k manifests on the dev box; bounded memory).
- Warm bounded commands: O(limit) memory; stat walk O(N) but no file content
  is read except the selected entries.
- `git log` trailer scan is O(history) for association; at 100k commits ≈ 3 s
  (measured); acceptable and documented.
- App intake is CPU-bound on HMAC+JSON; single node measured ≥ 7× the 2×-peak
  modeled rate.

## 10. Operational gaps

None known within the documented capacity envelope; SLOs, runbooks, and
disaster-recovery procedures are in SLOS.md / OPERATIONS_RUNBOOK.md /
DISASTER_RECOVERY.md. Multi-replica deployment is now supported by the
Postgres queue adapter (§8.1); the operational runbook documents the
`DRIFT_APP_QUEUE=postgres` configuration.
