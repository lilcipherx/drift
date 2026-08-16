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
import { type ManifestValidationError, type PublicIntentView } from "@drift/core";
import type { GitHubClientLike, PullCommit } from "./github.js";
import type { ProvenanceAudit } from "./trust.js";
export interface IntentFileView {
    path: string;
    mutationType: string;
    summary: string | null;
}
/**
 * Signature/trust state of a manifest against the base-branch trust root:
 *   valid           — verifies against the base key (and V2 signingKeyId
 *                     matches the base key fingerprint).
 *   invalid         — a signature exists but does not verify against base/head
 *                     (including a failed bootstrap signature).
 *   unsigned        — no signature recorded.
 *   unverifiable    — no usable verification material (malformed key).
 *   untrusted-key   — verifies only against a PR-replaced key (rotation).
 *   bootstrap       — base branch has no Drift key AND the head signature
 *                     verifies against the head key (initial adoption).
 *   malformed       — the manifest fails strict schema validation.
 *   missing         — no manifest found.
 */
export type SignatureState = "valid" | "invalid" | "unsigned" | "unverifiable" | "untrusted-key" | "bootstrap" | "malformed" | "missing";
export interface IntentView {
    id: string;
    authorType: string;
    authorId: string;
    model: string | null;
    /**
     * Safe public summary — the ONLY text ever rendered. When a manifest is
     * missing or malformed, a generic non-prompt fallback (`Drift intent <id>`)
     * is used; the commit subject is NEVER used (legacy `full`-mode subjects may
     * contain a complete private prompt).
     */
    summary: string;
    verifyCmd: string | null;
    files: IntentFileView[];
    /** True only when the manifest is validly signed by the base trust root. */
    signature: boolean;
    signatureState: SignatureState;
    /** True when no public manifest exists for this intent. */
    missingManifest: boolean;
    /** True when a manifest exists but fails strict schema validation. */
    malformedManifest: boolean;
    /** First validation error, when malformed (actionable diagnostic). */
    manifestError?: string;
}
/** Extract unique, valid Drift-Intent ids referenced by a set of commits. */
export declare function extractIntentIds(commits: PullCommit[]): string[];
export interface LoadedManifest {
    manifest: PublicIntentView | null;
    errors: ManifestValidationError[] | null;
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
export declare function parseLoadedManifest(raw: string | null, expectedId: string): LoadedManifest;
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
export declare function signatureStateFor(loaded: LoadedManifest, baseKey: string | null, headKey: string | null): SignatureState;
/**
 * Load the public manifests referenced by a PR and verify them against the
 * BASE-branch trust root (`baseRef`). When `baseRef` is omitted (tests, or a
 * payload without base info) the head key is used with state \"bootstrap\" —
 * callers should always pass the base SHA in production.
 */
export declare function fetchIntents(github: GitHubClientLike, owner: string, repo: string, ref: string, commits: PullCommit[], ids: string[], baseRef?: string): Promise<IntentView[]>;
/**
 * Bounded PER-PR audit limits. These apply ONLY to public provenance files
 * CHANGED or INSPECTED by the current pull request — never to the repository's
 * accumulated history. A repository with a million unchanged historical
 * manifests must still allow an ordinary source-only PR without loading any
 * of them. The Action documents the same semantics in SECURITY.md.
 */
export declare const MAX_CHANGED_PUBLIC_FILES_PER_PR = 200;
export declare const MAX_TOTAL_CHANGED_PROVENANCE_BYTES_PER_PR: number;
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
export declare function auditProvenanceIntegrity(github: GitHubClientLike, owner: string, repo: string, prNumber: number, commits: PullCommit[], baseSha: string, headSha: string): Promise<ProvenanceAudit>;
//# sourceMappingURL=intents.d.ts.map