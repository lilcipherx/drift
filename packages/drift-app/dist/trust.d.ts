/**
 * Shared trust policy for the Drift GitHub App (issues A, B, C, D):
 *
 *  - `evaluateKeyChange` — detect base/head trust-root differences BEFORE any
 *    \"no intents\" early return, so a key-only PR is never invisible.
 *  - `isDriftOwnedComment` — a marker string alone is NOT proof of ownership;
 *    only GitHub-attested authors (github-actions[bot] login, or a real
 *    `performed_via_github_app.id`) are ever updated.
 *  - `deriveProvenanceConclusion` — the ONE policy that maps provenance state
 *    to a Check Run conclusion. The App never reports unconditional success:
 *    invalid/untrusted/malformed/key-change provenance fails the check.
 */
import { type TrustRootChange } from "@drift/core";
import type { IntentView } from "./intents.js";
/** Comment marker version 2 — the App owns the app-specific marker and must
 * never edit the Action's comment (and vice versa). Legacy markers are
 * recognized for in-place migration ONLY when ownership is independently
 * verified (a performed_via_github_app.id set by GitHub, never a user). */
export declare const SUMMARY_MARKER = "<!-- drift:app-summary:v2 -->";
export declare const ACTION_MARKER = "<!-- drift:action-summary:v2 -->";
export declare const LEGACY_SUMMARY_MARKERS: string[];
export declare const TRUST_ROOT_WARNING = "## \u26A0 Drift trust-root change detected\n\nThis pull request modifies `.drift/public/key.pem`.\n\nNew provenance cannot be trusted automatically until the key rotation is reviewed through the documented rotation process.";
/**
 * Trust-root relationship between the base branch and the PR head. This is
 * the SHARED @drift/core evaluator (the Action mirrors it): strict PEM
 * parsing into absent/valid/malformed + canonical SPKI-DER fingerprints. A
 * malformed key NEVER receives a fallback identity and is NEVER a trusted
 * state — malformed-bootstrap, malformed-replacement and base-malformed are
 * explicit failures. The same key with LF/CRLF/whitespace formatting is
 * "unchanged".
 */
export type KeyChange = TrustRootChange;
export declare function evaluateKeyChange(baseKey: string | null | undefined, headKey: string | null | undefined): KeyChange;
/** A PR comment as returned by the GitHub API (ownership-relevant fields). */
export interface CommentIdentity {
    body: string;
    user?: {
        login?: string;
        type?: string;
    } | null;
    performed_via_github_app?: {
        id?: number;
    } | null;
}
/**
 * A comment belongs to the APP ONLY when GitHub itself attests that THIS App
 * authored it (`performed_via_github_app.id` set by GitHub, never by the
 * commenter) AND that id equals the CONFIGURED Drift App id. An arbitrary
 * positive id is not ownership — a different GitHub App that happens to use
 * the marker must never be edited (issue 7). When the expected App id is
 * unavailable (empty in production), ownership can not be proven, so no
 * comment is treated as owned (fail-safe: we may post new comments but never
 * PATCH a possibly-foreign comment). Comments authored by the composite
 * Action (`github-actions[bot]` login) belong to the Action and the App must
 * never edit them; user-authored bodies that merely contain a marker are
 * spoofs and are never touched.
 */
export declare function isDriftOwnedComment(comment: CommentIdentity | null | undefined, expectedAppId: string | null | undefined): boolean;
/**
 * Find the canonical owned comment (v2 marker first, legacy for migration) —
 * deterministically the OLDEST owned comment (lowest id), so repeated
 * webhook deliveries always update the same comment. Returns the canonical
 * comment plus the number of additional owned duplicates (for diagnostics).
 */
export declare function findOwnedDriftComment(comments: (CommentIdentity & {
    id: number;
})[], expectedAppId: string | null | undefined): {
    id: number;
    duplicates: number;
} | null;
export type ProvenanceConclusion = "success" | "neutral" | "failure";
/** A public-provenance integrity violation (append-only rules). */
export interface IntegrityViolation {
    code: "modified" | "deleted" | "renamed" | "orphan" | "intro-mismatch" | "mutated" | "trailer-without-manifest" | "incomplete-commit-audit";
    id: string;
    detail: string;
}
export interface ProvenanceAudit {
    violations: IntegrityViolation[];
    replayIds: string[];
    ambiguousIds: string[];
}
export declare const NO_AUDIT: ProvenanceAudit;
export interface ConclusionInput {
    intents: Pick<IntentView, "signatureState">[];
    keyChange: KeyChange;
    audit?: ProvenanceAudit;
}
export interface ConclusionResult {
    conclusion: ProvenanceConclusion;
    title: string;
    summary: string;
}
/**
 * The default policy — the App never reports unconditional success:
 *
 *   success: every referenced manifest is valid against the trusted base key,
 *            no trust-root modification, and no public-provenance integrity
 *            violation (modified/deleted/renamed/orphan manifest, replayed
 *            intent, ambiguous commit association).
 *   failure: any invalid signature, any untrusted-key state, any malformed
 *            manifest, a trust-root replacement/removal (incl. key-only PRs),
 *            or ANY public-provenance integrity violation.
 *   neutral: initial verified bootstrap, unsigned/unverifiable provenance,
 *            missing manifests, mixed valid+neutral sets, or no Drift intents
 *            and no key modification.
 */
export declare function deriveProvenanceConclusion(input: ConclusionInput): ConclusionResult;
//# sourceMappingURL=trust.d.ts.map