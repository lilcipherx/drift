/**
 * Read `Drift-Intent: <id>` trailers from pull request commits (git-trailer
 * aligned) and hydrate the SAFE public provenance from
 * `.drift/public/intents/<id>.json` at the PR head (ADR-009).
 *
 * Private data (prompts, `objects/`, `drift.db`) is never read here and
 * never rendered: comments show only the public summary + metadata.
 */
import { canonicalJson, extractDriftIntentIds, verifyPayload } from "@drift/core";
/** Extract unique, valid Drift-Intent ids referenced by a set of commits. */
export function extractIntentIds(commits) {
    const ids = [];
    const seen = new Set();
    for (const commit of commits) {
        for (const id of extractDriftIntentIds(commit.message)) {
            if (!seen.has(id)) {
                seen.add(id);
                ids.push(id);
            }
        }
    }
    return ids;
}
/**
 * Load the public manifests referenced by a PR. Falls back to the commit
 * message subject as the summary when the manifest is missing (e.g. an
 * intent realized before ADR-009, or `.drift/public` not committed).
 */
export async function fetchIntents(github, owner, repo, ref, commits, ids) {
    if (ids.length === 0)
        return [];
    // The manifest path is deterministic per intent id.
    const loaded = new Map();
    for (const id of ids) {
        const raw = await github.getFileContent(owner, repo, `.drift/public/intents/${id}.json`, ref);
        if (!raw)
            continue;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.id === id)
                loaded.set(id, parsed);
        }
        catch {
            // malformed manifest — fall back to the commit subject
        }
    }
    // Public key for signature verification (when committed).
    let publicKey = null;
    const keyRaw = await github.getFileContent(owner, repo, ".drift/public/key.pem", ref);
    if (keyRaw && keyRaw.includes("PUBLIC KEY"))
        publicKey = keyRaw.trim();
    // subject fallback: map each intent id to the commit that introduced it
    const subjectByIntent = new Map();
    for (const commit of commits) {
        for (const id of extractDriftIntentIds(commit.message)) {
            if (!subjectByIntent.has(id)) {
                subjectByIntent.set(id, commit.message.split("\n")[0] ?? "");
            }
        }
    }
    const views = [];
    for (const id of ids) {
        const manifest = loaded.get(id);
        views.push({
            id,
            authorType: manifest?.agent?.type ?? "unknown",
            authorId: manifest?.agent?.identifier ?? "unknown",
            model: manifest?.model ?? null,
            summary: manifest?.summary ?? subjectByIntent.get(id) ?? "",
            verifyCmd: manifest?.verification ?? null,
            files: (manifest?.files ?? []).map((f) => ({
                path: f.path ?? "?",
                mutationType: f.mutationType ?? "MODIFIED",
                summary: f.summary ?? null,
            })),
            signature: Boolean(manifest?.signature) &&
                Boolean(publicKey) &&
                verifyManifestSignature(manifest, publicKey),
        });
    }
    return views;
}
/** Verify a manifest's Ed25519 signature against the committed public key. */
function verifyManifestSignature(manifest, publicKey) {
    const { signature, ...unsigned } = manifest;
    if (!signature || !unsigned.id)
        return false;
    try {
        return verifyPayload(canonicalJson(unsigned), publicKey, signature);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=intents.js.map