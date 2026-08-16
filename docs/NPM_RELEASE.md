# Publishing Drift to npm

Exact steps for the **repository owner** to publish the `@drift/*` packages for
the first time (and for every release after). Everything here was verified
locally on Windows (Node v24.18.0, npm 11.16.0) except the `npm publish` /
`npm whoami` steps, which need your npm account credentials.

## Prerequisites

1. An npm account with **Read and publish** access to the `@drift` scope —
   create the org first: npmjs.com → **Organizations** → *Create organization*
   → name it `drift`. (If the scope is already taken, see
   [Scope collision](#scope-collision).)
2. Log in on the machine that will publish:

   ```bash
   npm adduser
   npm whoami        # must print your username
   ```

   (Or put a **Read and publish** token in `C:\Users\you\.npmrc`:
   `//registry.npmjs.org/:_authToken=<token>` — then `npm whoami`.)

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
bash scripts/publish-npm.sh
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

If the `@drift` scope already belongs to someone else (it may — it is a
common word), pick a different scope, e.g. `@drift-dev` or `@lilcipherx/drift`,
update every package `name` **and** every `@drift/*` dependency reference in
`packages/*/package.json` and `package-lock.json`, then re-run this checklist.
The repo's internal imports (`@drift/core` etc.) are workspace-linked, so only
the published names change.
