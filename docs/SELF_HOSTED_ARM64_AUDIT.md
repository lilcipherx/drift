# Self-hosted ARM64 runner audit

Audit of the repository against the existing persistent GitHub self-hosted
runner, and the migration decisions for trusted Linux CI.

## 1. Runner parameters

| Parameter | Value |
| :--- | :--- |
| Provider | Oracle Cloud |
| Instance family | Ampere A1 |
| OS | Ubuntu 24.04 |
| Architecture | ARM64 / aarch64 |
| OCPU | 2 |
| RAM | 12 GB |
| GitHub labels | `self-hosted`, `Linux`, `ARM64` |
| Type | **Persistent** (not an ephemeral clean VM) |

The runner is already installed, registered, and active. Nothing in this
repository creates, registers, removes, or re-labels a runner, and no runner
credentials are stored here.

## 2. Repository-wide scope inspected

Files inspected (content, not just names):

- `.github/workflows/ci.yml` (the only workflow; no reusable workflows, no
  `.github/actions/`, no composite/Docker/JavaScript local actions)
- `action.yml` (the published GitHub Action — runs on the *consumer's*
  runner, not this repo's CI)
- `package.json` + `package-lock.json` (dependencies, engines, scripts)
- `packages/*/package.json` (per-package dependencies)
- `scripts/*.sh`, `scripts/*.mjs` (seed, acceptance, publish, pr-comment)
- `eval/`, `tests/` (harness and test suites run by CI)
- `docs/installation.md` (the consumer-facing Action workflow example)
- `Dockerfile*`, `docker-compose*`, `Makefile`, `Taskfile*` — none exist
- Search for `runs-on`, `ubuntu-latest`, `windows-latest`, `macos-latest`,
  `self-hosted`, `x86_64`, `amd64`, `aarch64`, `arm64`, `uname -m` — no
  architecture-specific downloads anywhere outside `ci.yml`.

## 3. Job classification

| Workflow | Job | Current runner | Trigger | Trust level | ARM64 compatibility | Proposed runner | Decision | Evidence | Remaining risk |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| ci.yml | `test` (matrix) | `ubuntu-latest` + `windows-latest` × Node 24 | push (main), PR, dispatch | mixed (trusted + forks) | pure-JS toolchain | split (below) | `CONDITIONAL_SPLIT` | static | n/a |
| ci.yml | `test-linux-arm64` (new) | — | push (main), dispatch, same-repo PR | trusted only | statically compatible | `[self-hosted, Linux, ARM64]` | `MOVE_TO_SELF_HOSTED` | static + local Windows/x64 runs; **ARM64 runtime unverified** | Node 24 must be installed on the host (see §7); runtime behavior on ARM64 not yet observed |
| ci.yml | `test-linux-fork` (new) | — | fork PR only | untrusted | compatible | `ubuntu-latest` (ephemeral) | `MOVE_TO_SELF_HOSTED` → **fork fallback kept hosted** | static | none — fork code never touches the persistent runner |
| ci.yml | `test-windows` (new) | — | all events | mixed | Windows-only | `windows-latest` (no Windows self-hosted runner exists) | `KEEP_GITHUB_HOSTED` | static | none |
| ci.yml | `test-windows` (matrix variant) | `windows-latest` × Node 24 | all events | mixed | n/a (Windows) | unchanged | `KEEP_GITHUB_HOSTED` | static | none |

Evidence levels used below: **static** (read-only inspection),
**locally tested** (executed on the author's machine), and **verified on
ARM64 self-hosted runner** (a real workflow run on the ARM64 box — none
exists yet; see §9).

## 4. ARM64 compatibility review

### 4.1 `uses:` actions

| Action | Type | ARM64 note |
| :--- | :--- | :--- |
| `actions/checkout@v4` | JavaScript | Architecture-independent (pure Node). |
| `actions/setup-node@v4` | JavaScript | Downloads a Node distribution; official Node builds exist for linux-arm64, so ARM64 is supported. |

No Docker actions, no composite actions, no third-party marketplace actions,
no security-scanning or release actions are used.

### 4.2 Runtime technology

- **Node.js** — official linux-arm64 builds exist (Node 24 LTS line).
- **npm** — shipped with Node; architecture-independent.
- **Native npm modules** — none. `package-lock.json` contains zero
  `node-gyp`/`prebuild`/`node-pre-gyp`/`napi` entries and zero
  platform-restricted (`os`/`cpu`) packages. Drift uses `node:sqlite`,
  which is built into Node (no native install step).
- **TypeScript / zod / @modelcontextprotocol/sdk** — pure JavaScript.
- **Docker / Compose / Buildx / service containers** — not used by any
  workflow, script, or test.
- **Precompiled binaries / architecture-specific downloads** — none; the
  only "downloads" are the Node distribution and npm packages (both
  architecture-correct via the package manager).
- **ffmpeg, Playwright, PostgreSQL, Redis, Go, Rust, Java, Python, Terraform** — none are used.

### 4.3 Cache isolation

`test-linux-arm64` deliberately does **not** use `actions/setup-node`'s
`cache: npm`: the generated cache key does not include the CPU architecture,
so an ARM64 job must not write a cache that a later x64 job could restore.
The GitHub-hosted jobs keep their own npm caches. No secrets, credentials,
private Drift records, or signing keys are ever cached.

## 5. Fork trust boundary

The self-hosted runner is persistent — untrusted fork code must never run
there, even without secrets. `test-linux-arm64` is gated with:

```yaml
if: >
  github.event_name != 'pull_request' ||
  github.event.pull_request.head.repo.full_name == github.repository
```

Fork PRs run the identical suite on an ephemeral `ubuntu-latest` runner
(`test-linux-fork`). No `pull_request_target` is used anywhere.

## 6. Persistent-runner hygiene

- **Workspace**: `actions/checkout` cleans the repository workspace before
  each run (scoped to `GITHUB_WORKSPACE`); `persist-credentials: false`
  everywhere — this CI never writes.
- **Credentials**: workflow `permissions: contents: read`; no tokens, npm
  credentials, or signing keys are requested or cached.
- **Docker**: not used; no containers/networks/volumes to clean up. No
  `docker system prune` or `docker volume prune` commands exist anywhere.
- **Temporary files**: CI scripts use `mktemp -d` inside the runner's temp
  space; no broad `rm -rf` outside job-owned paths.
- **Background processes**: none of the CI scripts start servers or
  watchers; no `pkill` used.
- **Sudo**: no workflow step uses `sudo`; host prerequisites (§7) are a
  one-time manual setup, not a CI step.
- **Leftover state**: `npm ci` + fresh checkout make the build
  deterministic; the pack-smoke test uses a fresh `mktemp -d`.

## 7. Host prerequisites (one-time, on the runner)

Required — Ubuntu 24.04 ARM64:

```bash
# Node 24 LTS (via NodeSource, ARM64)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version   # v24.x
npm --version
uname -m         # aarch64
```

Optional: none (no native compilation, no Docker, no Python needed — this
toolchain is pure JavaScript).

Verification:

```bash
node -e "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(':memory:'); console.log('node:sqlite OK')"
```

Packages intentionally **not** required: `build-essential`, `python3`,
`make`, `g++`, `pkg-config` (no native modules), Docker and all
container tooling (not used), x86 emulation layers (never needed).

## 8. GitHub Action (`action.yml`)

The published Action runs on the **consumer's** workflow runner, not on this
repository's CI. It is a Node 20 JavaScript action (`node20` runtime) with no
Docker image and no architecture-specific assets, so it is architecture
agnostic for consumers. The example in `docs/installation.md` uses
`runs-on: ubuntu-latest`, which is a consumer-side choice and is unchanged.

## 9. Evidence and remaining risks

- The classification of `test-linux-arm64` as `MOVE_TO_SELF_HOSTED` was
  **static** plus **locally tested on Windows/x64** before the first push.
- **Verified on ARM64 self-hosted runner** — workflow runs
  https://github.com/lilcipherx/drift/actions/runs/31941092554 and
  https://github.com/lilcipherx/drift/actions/runs/31944862922 (PR #7,
  2026-08-16): the `test (Linux ARM64, node 24)` job ran on the persistent
  Oracle runner (`instance-20260816-0446`, labels `self-hosted`/`Linux`/
  `ARM64`, status `online`) and completed **success** (~1m25s, then ~1m18s
  after the merge-blocker fix commits) — `npm ci`, `tsc -b`, the full test
  suite (147 then 158 tests), eval gate, MVS acceptance and the package
  smoke test all passed on the ARM64 host. Node 24 is present (§7).
- Remaining risk: low. The same toolchain is pure JavaScript; the only
  environment-sensitive input (Node 24) is now confirmed on the host. If a
  future ARM64 run exposes an issue, fall back to `ubuntu-latest` for
  `test-linux-arm64` until resolved — the fork/Windows jobs are unaffected.

## 10. Triggering a manual run

When a maintainer's GitHub authentication is restored, trigger a full check
on the self-hosted runner from the web UI:

1. Open https://github.com/lilcipherx/drift/actions/workflows/ci.yml
2. Click **Run workflow** → select branch `fix/privacy-pr-provenance` → **Run workflow**.
3. Confirm the `test-linux-arm64` job reports **Use** of the `ARM64`
   self-hosted runner and completes green; then update §9 with the run URL.

Equivalent CLI (needs `gh` auth):

```bash
gh workflow run ci.yml --ref fix/privacy-pr-provenance
```

## 11. Branch-protection note

Splitting the old matrix job into `test-linux-arm64`, `test-linux-fork` and
`test-windows` changes the check names. If branch protection on `main` lists
the old `test (ubuntu-latest, node 24)` / `test (windows-latest, node 24)`
checks, a maintainer must update the required checks to the new job names.
