/**
 * Read `Drift-Intent: <id>` trailers from pull request commits (git-trailer
 * aligned) and hydrate the SAFE public provenance from
 * `.drift/public/intents/<id>.json` (ADR-009).
 *
 * Private data (prompts, `objects/`, `drift.db`) is never read here and
 * never rendered: comments show only the public summary + metadata.
 *
 * Trust model: manifests are verified against the BASE-branch public key —
 * the PR head key is untrusted until a controlled rotation. A PR that
 * replaces `.drift/public/key.pem` is detected and its provenance is marked
 * unverified, never silently trusted.
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
 * Resolve the signature/trust state of a manifest against the trusted base
 * key and the (untrusted) PR-head key.
 */
function signatureStateFor(manifest, baseKey, headKey) {
    if (!manifest)
        return "missing";
    if (!manifest.signature)
        return "unsigned";
    if (!baseKey && !headKey)
        return "unverifiable";
    if (baseKey && verifyManifestSignature(manifest, baseKey))
        return "valid";
    if (headKey && verifyManifestSignature(manifest, headKey)) {
        return baseKey ? "untrusted-key" : "bootstrap";
    }
    if (!baseKey)
        return "bootstrap";
    return "invalid";
}
/**
 * Load the public manifests referenced by a PR and verify them against the
 * BASE-branch trust root (`baseRef`). When `baseRef` is omitted (tests, or a
 * payload without base info) the head key is used with state "bootstrap" —
 * callers should always pass the base SHA in production.
 */
export async function fetchIntents(github, owner, repo, ref, commits, ids, baseRef) {
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
            // malformed manifest — treated as missing (generic fallback below)
        }
    }
    // Trust root: the BASE-branch public key (never the untrusted PR head key).
    const baseRefToUse = baseRef ?? ref;
    const baseKey = await readKey(github, owner, repo, baseRefToUse);
    // The head key is only used to DETECT a key replacement / rotation.
    const headKey = ref === baseRefToUse ? baseKey : await readKey(github, owner, repo, ref);
    const views = [];
    for (const id of ids) {
        const manifest = loaded.get(id) ?? null;
        const state = signatureStateFor(manifest, baseKey, headKey);
        views.push({
            id,
            authorType: manifest?.agent?.type ?? "unknown",
            authorId: manifest?.agent?.identifier ?? "unknown",
            model: manifest?.model ?? null,
            summary: manifest?.summary ?? `Drift intent ${id}`,
            verifyCmd: manifest?.verification ?? null,
            files: (manifest?.files ?? []).map((f) => ({
                path: f.path ?? "?",
                mutationType: f.mutationType ?? "MODIFIED",
                summary: f.summary ?? null,
            })),
            signature: state === "valid",
            signatureState: state,
            missingManifest: manifest === null,
        });
    }
    return views;
}
async function readKey(github, owner, repo, ref) {
    const keyRaw = await github.getFileContent(owner, repo, ".drift/public/key.pem", ref);
    if (keyRaw && keyRaw.includes("PUBLIC KEY"))
        return keyRaw.trim();
    return null;
}
/** Verify a manifest's Ed25519 signature against a PEM public key. */
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