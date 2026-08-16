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
import type { GitHubClientLike, PullCommit } from "./github.js";
export interface IntentFileView {
    path: string;
    mutationType: string;
    summary: string | null;
}
/**
 * Signature/trust state of a manifest against the base-branch trust root:
 *   valid           — verifies against the base key.
 *   invalid         — a signature exists but does not verify against base/head.
 *   unsigned        — no signature recorded.
 *   unverifiable    — no verification material available.
 *   untrusted-key   — verifies only against a PR-replaced key (rotation).
 *   bootstrap       — base branch has no Drift key (initial adoption).
 *   missing         — no manifest found.
 */
export type SignatureState = "valid" | "invalid" | "unsigned" | "unverifiable" | "untrusted-key" | "bootstrap" | "missing";
export interface IntentView {
    id: string;
    authorType: string;
    authorId: string;
    model: string | null;
    /**
     * Safe public summary — the ONLY prompt-derived text ever rendered. When a
     * manifest is missing, a generic non-prompt fallback (`Drift intent <id>`)
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
}
/** Extract unique, valid Drift-Intent ids referenced by a set of commits. */
export declare function extractIntentIds(commits: PullCommit[]): string[];
/**
 * Load the public manifests referenced by a PR and verify them against the
 * BASE-branch trust root (`baseRef`). When `baseRef` is omitted (tests, or a
 * payload without base info) the head key is used with state "bootstrap" —
 * callers should always pass the base SHA in production.
 */
export declare function fetchIntents(github: GitHubClientLike, owner: string, repo: string, ref: string, commits: PullCommit[], ids: string[], baseRef?: string): Promise<IntentView[]>;
//# sourceMappingURL=intents.d.ts.map