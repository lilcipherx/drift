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
import { MANIFEST_MAX_BYTES, canonicalJson, extractDriftIntentIds, parsePublicIntentManifest, signingKeyIdFor, verifyPayload, } from "@drift/core";
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
 * is rejected outright. The raw BYTE length is enforced BEFORE `JSON.parse`
 * so an arbitrarily large tracked file is never loaded into the parser
 * (issue 8) — the connector already returns a string, so the length check
 * happens before any structural work.
 */
export function parseLoadedManifest(raw, expectedId) {
    if (!raw)
        return { manifest: null, errors: null };
    if (Buffer.byteLength(raw, "utf8") > MANIFEST_MAX_BYTES) {
        return {
            manifest: null,
            errors: [{ field: "$file", message: `manifest exceeds maximum size ${MANIFEST_MAX_BYTES} bytes` }],
        };
    }
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
 * Bounded PER-PR audit limits. These apply ONLY to public provenance files
 * CHANGED or INSPECTED by the current pull request — never to the repository's
 * accumulated history. A repository with a million unchanged historical
 * manifests must still allow an ordinary source-only PR without loading any
 * of them. The Action documents the same semantics in SECURITY.md.
 */
export const MAX_CHANGED_PUBLIC_FILES_PER_PR = 200;
export const MAX_TOTAL_CHANGED_PROVENANCE_BYTES_PER_PR = 50 * 1024 * 1024;
const PUBLIC_INTENTS_PREFIX = ".drift/public/intents/";
/** Extract the manifest id from a `.drift/public/intents/<id>.json` path. */
function manifestIdFromPath(path) {
    const m = /^\.drift\/public\/intents\/(did_[0-9a-f]{32})\.json$/.exec(path);
    return m ? m[1] : null;
}
/**
 * Audit ONLY the public provenance CHANGED by this pull request — via the
 * paginated Pull Request Files API as the primary changed-path source. A PR
 * can tamper with existing provenance without adding any `Drift-Intent:`
 * trailer; that must be a FAILING condition, not invisible. Rules (ADR-009
 * append-only model):
 *
 *   added manifest     → orphan when NO PR commit references the id; the
 *                        introducing commit (the first PR commit where the
 *                        file exists) must carry exactly ONE matching
 *                        `Drift-Intent:` trailer (intro-mismatch otherwise);
 *                        the head content must be byte-identical to the
 *                        introduction content (added-then-modified =
 *                        `mutated` violation).
 *   modified manifest  → violation (append-only).
 *   deleted manifest   → violation (append-only).
 *   renamed manifest   → violation (append-only).
 *   trailer for an id whose manifest exists on the base branch → replay.
 *   one id referenced by >1 distinct PR commit → ambiguous association.
 *
 * Unchanged historical manifests are NEVER enumerated or compared: they are
 * not in the changed-files response and therefore cannot produce a violation.
 * Limits apply to changed files only; an incomplete changed-files listing
 * (pagination cap hit) is reported as a violation, never inferred as "no
 * public changes".
 */
export async function auditProvenanceIntegrity(github, owner, repo, prNumber, commits, baseSha, headSha) {
    const violations = [];
    const replayIds = [];
    const ambiguousIds = [];
    // Which PR commits reference each id (atomic association requires exactly
    // ONE referencing commit).
    const refCommits = new Map();
    for (const commit of commits) {
        for (const id of extractDriftIntentIds(commit.message)) {
            const list = refCommits.get(id) ?? [];
            list.push(commit.sha);
            refCommits.set(id, list);
        }
    }
    // PRIMARY SOURCE: the paginated PR changed-files listing. Incomplete
    // pagination must fail safely — a partial listing is never treated as "no
    // public changes".
    const { files, truncated } = await github.getPullFiles(owner, repo, prNumber);
    if (truncated) {
        violations.push({
            code: "modified",
            id: "(audit)",
            detail: "the changed-files listing is incomplete (pagination cap) — audit cannot conclude",
        });
        return { violations, replayIds, ambiguousIds };
    }
    // Changed public-provenance paths only (key.pem is evaluated separately by
    // the trust-root change detection — it is not an integrity violation).
    const changed = files.filter((f) => f.filename.startsWith(PUBLIC_INTENTS_PREFIX) || (f.previous_filename ?? "").startsWith(PUBLIC_INTENTS_PREFIX));
    if (changed.length > MAX_CHANGED_PUBLIC_FILES_PER_PR) {
        violations.push({
            code: "modified",
            id: "(audit)",
            detail: `more than ${MAX_CHANGED_PUBLIC_FILES_PER_PR} public provenance files changed by this PR — bounded audit`,
        });
        return { violations, replayIds, ambiguousIds };
    }
    let totalChangedBytes = 0;
    for (const f of changed) {
        const id = manifestIdFromPath(f.filename);
        const oldId = manifestIdFromPath(f.previous_filename ?? "");
        const status = f.status;
        if (status === "renamed") {
            violations.push({
                code: "renamed",
                id: oldId ?? id ?? f.filename,
                detail: `${f.previous_filename ?? "?"} → ${f.filename}`,
            });
            continue;
        }
        if (!id)
            continue; // non-manifest public file (e.g. key.pem) — handled elsewhere
        const headRaw = await github.getFileContent(owner, repo, f.filename, headSha);
        if (headRaw !== null)
            totalChangedBytes += Buffer.byteLength(headRaw, "utf8");
        if (status === "added") {
            const refs = refCommits.get(id) ?? [];
            if (refs.length === 0) {
                violations.push({
                    code: "orphan",
                    id,
                    detail: "new public manifest added without any Drift-Intent trailer on this PR",
                });
                continue;
            }
            if (refs.length > 1) {
                ambiguousIds.push(id);
                continue;
            }
            const introSha = await introductionCommit(github, owner, repo, f.filename, commits, headSha);
            if (!introSha) {
                violations.push({ code: "orphan", id, detail: "could not determine the manifest's introducing commit" });
                continue;
            }
            if (introSha !== refs[0]) {
                violations.push({
                    code: "intro-mismatch",
                    id,
                    detail: `manifest introduced by ${introSha.slice(0, 7)} but its Drift-Intent trailer is on ${refs[0].slice(0, 7)} — the introducing commit must carry exactly one matching trailer`,
                });
                continue;
            }
            const introRaw = await github.getFileContent(owner, repo, f.filename, introSha);
            if (introRaw !== headRaw) {
                violations.push({
                    code: "mutated",
                    id,
                    detail: "manifest was modified after it was introduced in the same pull request (added-then-modified)",
                });
            }
            continue;
        }
        if (status === "modified") {
            violations.push({
                code: "modified",
                id,
                detail: "an existing public manifest must be append-only (content changed on this PR)",
            });
            continue;
        }
        if (status === "deleted") {
            violations.push({ code: "deleted", id, detail: "an existing public manifest must not be deleted by a pull request" });
        }
    }
    if (totalChangedBytes > MAX_TOTAL_CHANGED_PROVENANCE_BYTES_PER_PR) {
        violations.push({
            code: "modified",
            id: "(audit)",
            detail: `total provenance content changed by this PR exceeds ${MAX_TOTAL_CHANGED_PROVENANCE_BYTES_PER_PR} bytes — bounded audit`,
        });
    }
    // Replay: a PR commit references an intent whose manifest already exists
    // on the base branch. Checked per trailer id (bounded by trailer count) —
    // never by enumerating the repository's full manifest history.
    for (const id of refCommits.keys()) {
        const baseRaw = await github.getFileContent(owner, repo, `.drift/public/intents/${id}.json`, baseSha);
        if (baseRaw !== null)
            replayIds.push(id);
    }
    return { violations, replayIds, ambiguousIds };
}
/**
 * The first PR commit (oldest first — GitHub returns `pulls/{n}/commits` in
 * chronological order) whose tree contains the manifest path. Used to verify
 * that the manifest was introduced by the same commit that carries its
 * `Drift-Intent:` trailer and that head content is byte-identical to the
 * introduced content. Falls back to `headSha` when the commit list is
 * incomplete.
 */
async function introductionCommit(github, owner, repo, path, commits, headSha) {
    for (const commit of commits) {
        const raw = await github.getFileContent(owner, repo, path, commit.sha);
        if (raw !== null)
            return commit.sha;
    }
    // Not found in the listed commits — check the head itself as a last resort
    // (some PRs have commits outside the listed range).
    const headRaw = await github.getFileContent(owner, repo, path, headSha);
    return headRaw !== null ? headSha : null;
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