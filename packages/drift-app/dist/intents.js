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
 * unverified, never silently trusted. Manifests pass STRICT schema
 * validation (the same rules as `@drift/core`): malformed repository data
 * is reported as `malformed`, never rendered as valid, never a crash.
 */
import { canonicalJson, extractDriftIntentIds, parsePublicIntentManifest, signingKeyIdFor, verifyPayload, } from "@drift/core";
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
 * Strictly parse a manifest fetched from the GitHub API. `expectedId` must
 * match both the requested intent id and (indirectly) the file it was loaded
 * from — callers only fetch `intents/<id>.json`, so a mismatched embedded id
 * is rejected outright.
 */
export function parseLoadedManifest(raw, expectedId) {
    if (!raw)
        return { manifest: null, errors: null };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { manifest: null, errors: [{ field: "$file", message: "manifest is not valid JSON" }] };
    }
    const result = parsePublicIntentManifest(parsed, { expectedId });
    return result.ok ? { manifest: result.value, errors: null } : { manifest: null, errors: result.errors };
}
/** Whether a PEM string looks like a usable public key (never trusts garbage). */
function looksLikePublicKey(pem) {
    return typeof pem === "string" && pem.includes("PUBLIC KEY");
}
/**
 * Resolve the signature/trust state of a manifest against the trusted base
 * key and the (untrusted) PR-head key. Identical semantics to the Action's
 * `signatureStateFor` so the two integrations can never diverge:
 *
 *   base key exists:  verifies → valid; only head verifies → untrusted-key;
 *                     fails all → invalid.
 *   no base key:      head verifies → bootstrap; head signature fails → invalid
 *                     (a failed signature is NEVER bootstrap); no head key →
 *                     unverifiable.
 *   malformed base key → unverifiable (plus a key-change failure when the PR
 *                     introduced it as a replacement).
 */
export function signatureStateFor(loaded, baseKey, headKey) {
    if (loaded.errors && loaded.errors.length > 0)
        return "malformed";
    const manifest = loaded.manifest;
    if (!manifest)
        return "missing";
    if (typeof manifest.signature !== "string" || !manifest.signature)
        return "unsigned";
    const baseUsable = looksLikePublicKey(baseKey);
    const headUsable = looksLikePublicKey(headKey);
    if (baseKey && !baseUsable)
        return "unverifiable";
    const baseValid = baseUsable && verifyManifestSignature(manifest, baseKey);
    const headValid = headUsable && verifyManifestSignature(manifest, headKey);
    if (baseUsable) {
        if (baseValid) {
            // A cryptographically valid signature with a mismatched V2
            // `signingKeyId` must not be reported as valid.
            if (manifest.schemaVersion === 2 &&
                manifest.signingKeyId !== signingKeyIdFor(baseKey)) {
                return "invalid";
            }
            return "valid";
        }
        if (headValid)
            return "untrusted-key";
        return "invalid";
    }
    if (headUsable && headValid)
        return "bootstrap";
    if (headUsable)
        return "invalid";
    return "unverifiable";
}
/**
 * Load the public manifests referenced by a PR and verify them against the
 * BASE-branch trust root (`baseRef`). When `baseRef` is omitted (tests, or a
 * payload without base info) the head key is used with state \"bootstrap\" —
 * callers should always pass the base SHA in production.
 */
export async function fetchIntents(github, owner, repo, ref, commits, ids, baseRef) {
    if (ids.length === 0)
        return [];
    // The manifest path is deterministic per intent id.
    const loaded = new Map();
    for (const id of ids) {
        const raw = await github.getFileContent(owner, repo, `.drift/public/intents/${id}.json`, ref);
        loaded.set(id, parseLoadedManifest(raw, id));
    }
    // Trust root: the BASE-branch public key (never the untrusted PR head key).
    const baseRefToUse = baseRef ?? ref;
    const baseKey = await readKey(github, owner, repo, baseRefToUse);
    // The head key is only used to DETECT a key replacement / rotation.
    const headKey = ref === baseRefToUse ? baseKey : await readKey(github, owner, repo, ref);
    const views = [];
    for (const id of ids) {
        const entry = loaded.get(id) ?? { manifest: null, errors: null };
        const manifest = entry.manifest;
        const malformed = Boolean(entry.errors && entry.errors.length > 0);
        const state = signatureStateFor(entry, baseKey, headKey);
        views.push({
            id,
            authorType: manifest?.agent?.type ?? "unknown",
            authorId: manifest?.agent?.identifier ?? "unknown",
            model: manifest?.model ?? null,
            summary: manifest?.summary ?? `Drift intent ${id}`,
            verifyCmd: manifest?.verification ?? null,
            files: (manifest?.files ?? []).map((f) => ({
                path: f.path,
                mutationType: f.mutationType,
                summary: f.summary ?? null,
            })),
            signature: state === "valid",
            signatureState: state,
            missingManifest: manifest === null && !malformed,
            malformedManifest: malformed,
            ...(malformed && entry.errors && entry.errors.length > 0
                ? { manifestError: `${entry.errors[0].field}: ${entry.errors[0].message}` }
                : {}),
        });
    }
    return views;
}
// ---------------------------------------------------------------------------
// Public-provenance integrity audit (append-only rules, ADR-009)
// ---------------------------------------------------------------------------
const INTENT_FILE_RE = /^did_[0-9a-f]{32}\.json$/;
/**
 * Audit EVERY change under `.drift/public/intents/` on the PR — not just
 * trailer-derived intents. A PR can tamper with existing provenance without
 * adding any `Drift-Intent:` trailer; that must be a FAILING condition, not
 * invisible. Rules:
 *
 *   added manifest   → orphan when NO PR commit references the id, or when
 *                      more than one commit references it (ambiguous — the
 *                      single introducing commit must carry the matching
 *                      trailer).
 *   modified manifest → violation (append-only).
 *   deleted manifest  → violation (append-only).
 *   renamed manifest  → violation (append-only).
 *   trailer for an id whose manifest exists on the base branch → replay.
 *
 * The result feeds `deriveProvenanceConclusion` so any integrity break fails
 * the Check Run (never silently green).
 */
export async function auditProvenanceIntegrity(github, owner, repo, prNumber, commits, baseSha, headSha) {
    const violations = [];
    const replayIds = [];
    const ambiguousIds = [];
    // How many PR commits reference each id (atomic association requires 1).
    const commitCount = new Map();
    for (const commit of commits) {
        for (const id of extractDriftIntentIds(commit.message)) {
            commitCount.set(id, (commitCount.get(id) ?? 0) + 1);
        }
    }
    // File lists at base vs head (missing dirs → empty).
    const baseFiles = await github.listDirectory(owner, repo, ".drift/public/intents", baseSha);
    const headFiles = await github.listDirectory(owner, repo, ".drift/public/intents", headSha);
    const baseSet = new Set(baseFiles.filter((f) => INTENT_FILE_RE.test(f)));
    const headSet = new Set(headFiles.filter((f) => INTENT_FILE_RE.test(f)));
    for (const name of headSet) {
        const id = name.slice(0, -".json".length);
        if (baseSet.has(name)) {
            violations.push({ code: "modified", id, detail: "an existing public manifest must be append-only" });
            continue;
        }
        const n = commitCount.get(id) ?? 0;
        if (n === 0) {
            violations.push({ code: "orphan", id, detail: "new public manifest added without any Drift-Intent trailer on this PR" });
        }
        else if (n > 1) {
            ambiguousIds.push(id);
        }
    }
    for (const name of baseSet) {
        if (!headSet.has(name)) {
            const id = name.slice(0, -".json".length);
            violations.push({ code: "deleted", id, detail: "an existing public manifest must not be deleted by a pull request" });
        }
    }
    // Renames via the PR files API (status "renamed").
    const files = await github.getPullFiles(owner, repo, prNumber);
    for (const f of files) {
        if (f.status !== "renamed")
            continue;
        const movedInto = f.filename.startsWith(".drift/public/intents/") || (f.previous_filename ?? "").startsWith(".drift/public/intents/");
        if (movedInto) {
            violations.push({
                code: "renamed",
                id: (f.previous_filename ?? f.filename).split("/").pop() ?? "",
                detail: `${f.previous_filename ?? "?"} → ${f.filename}`,
            });
        }
    }
    // Replay: a PR commit references an intent whose manifest already exists
    // on the base branch.
    for (const id of commitCount.keys()) {
        if (baseSet.has(`${id}.json`))
            replayIds.push(id);
    }
    return { violations, replayIds, ambiguousIds };
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