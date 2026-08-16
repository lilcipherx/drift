# Publishing Drift to npm

Exact steps for the **repository owner** to publish the `@drift/*` packages for
the first time (and for every release after). Everything here was verified
locally on Windows (Node v24.18.0, npm 11.16.0) except the `npm publish` /
`npm whoami` steps, which need your npm account credentials.

## Prerequisites

1. **Scope ownership must be proven first.** The `@drift/*` packages are
   unpublished today (registry 404 — that is not ownership proof). See
   [docs/NPM_SCOPE_DECISION.md](NPM_SCOPE_DECISION.md) for the registry
   findings and the recommended `@lilcipherx` scope. Do not publish until the
   scope is verified with an authenticated `npm whoami` / `npm access`.
2. Log in on the machine that will publish:

   ```bash
   npm adduser
   npm whoami        # must print your username
   ```

   (Or put a **Read and publish** token in `C:\Users\you\.npmrc`:
   `//registry.npmjs.org/:_authToken=<token>` — then `npm whoami`.)

`scripts/publish-npm.sh` now has a safety preflight: it prints the target
packages, verifies `npm whoami` and the registry, supports `--dry-run`, and
**refuses to publish unless** `DRIFT_NPM_SCOPE_APPROVED=1` is set (an explicit
manual approval).

## Release checklist

```bash
# 1. Bump versions (keep ALL packages in lockstep — tests enforce this)
node -e "const fs=require('fs');const v='0.4.0';for(const p of ['drift-ast','drift-core','drift-cli','drift-sdk','drift-mcp','drift-app','drift-action']){const f='packages/'+p+'/package.json';const j=JSON.parse(fs.readFileSync(f));j.version=v;fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n')}"
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('package.json'));j.version='0.4.0';fs.writeFileSync('package.json',JSON.stringify(j,null,2)+'\n')"

# 2. Sync the lockfile, build, test, eval, acceptance
npm install --package-lock-only
npm run build
npm test
npm run eval
bash scripts/acceptance-mvs.sh

# 3. Sanity-check the tarballs locally (what npm will actually publish)
for p in drift-ast drift-core drift-cli drift-mcp; do
  (cd "packages/$p" && npm pack --dry-run)
done

# 4. Publish the chain in dependency order (the one-command script)
#    First a dry run, then — after explicit approval — the real publish:
bash scripts/publish-npm.sh --dry-run      # plan + npm publish --dry-run, no registry writes
DRIFT_NPM_SCOPE_APPROVED=1 bash scripts/publish-npm.sh
#    publishes @drift/ast → @drift/core → @drift/cli → @drift/mcp,
#    confirms each version on the registry, then launches
#    `npx -y @drift/mcp` from an EMPTY directory and checks the
#    JSON-RPC handshake (serverInfo + tools/list).

# 5. Optionally publish the SDK and the GitHub App package too
(cd packages/drift-sdk && npm publish --access public)
(cd packages/drift-app && npm publish --access public)

# 6. Tag + release the repository
git tag v0.4.0
git push origin v0.4.0
gh release create v0.4.0 --title "Drift v0.4.0" --notes "See CHANGELOG.md" --generate-notes
```

## After publishing

- The README's npx one-liners (`npx -y @drift/cli`, `npx -y @drift/mcp`) start
  working; the "not published yet" status notes can be removed and the npx
  commands moved back to first position in every manifest
  (`.claude-plugin/`, `.cursor-plugin/`, `.codex-plugin/`, `.plugin/`,
  `gemini-extension.json`, `examples/harness-configs/*`, `.opencode/INSTALL.md`).
- Record the live npx measurement in `docs/quickstart.md` → "Verified live"
  (empty dir → `npx -y @drift/cli --help` → MCP handshake).
- Open `npx -y @drift/cli --help` and `npx -y @drift/mcp` handshake from a
  clean directory and paste the real output into the docs.

## Verification (what "published" means)

```bash
npm view @drift/ast version
npm view @drift/core version
npm view @drift/cli version
npm view @drift/mcp version
cd "$(mktemp -d)" && npx -y @drift/cli --help && npx -y @drift/mcp   # handshake
```

## Scope collision

The `@drift` scope is a common word and ownership is **unverified** (an npm
404 means not published, not available). Registry research and the exact
rename checklist live in [docs/NPM_SCOPE_DECISION.md](NPM_SCOPE_DECISION.md):
pick a unique scope (recommended: `@lilcipherx`), update every package `name`
**and** every `@drift/*` dependency reference in `packages/*/package.json` and
`package-lock.json`, then re-run this checklist. The repo's internal imports
(`@drift/core` etc.) are workspace-linked, so only the published names change.
