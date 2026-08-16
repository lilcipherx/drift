/**
 * Read `Drift-Intent: <id>` trailers from pull request commits (git-trailer
 * aligned) and hydrate the SAFE public provenance from
 * `.drift/public/intents/<id>.json` at the PR head (ADR-009).
 *
 * Private data (prompts, `objects/`, `drift.db`) is never read here and
 * never rendered: comments show only the public summary + metadata.
 */
import type { GitHubClientLike, PullCommit } from "./github.js";
export interface IntentFileView {
    path: string;
    mutationType: string;
    summary: string | null;
}
export interface IntentView {
    id: string;
    authorType: string;
    authorId: string;
    model: string | null;
    /** Safe public summary — the ONLY prompt-derived text ever rendered. */
    summary: string;
    verifyCmd: string | null;
    files: IntentFileView[];
    signature: boolean;
}
/** Extract unique, valid Drift-Intent ids referenced by a set of commits. */
export declare function extractIntentIds(commits: PullCommit[]): string[];
/**
 * Load the public manifests referenced by a PR. Falls back to the commit
 * message subject as the summary when the manifest is missing (e.g. an
 * intent realized before ADR-009, or `.drift/public` not committed).
 */
export declare function fetchIntents(github: GitHubClientLike, owner: string, repo: string, ref: string, commits: PullCommit[], ids: string[]): Promise<IntentView[]>;
//# sourceMappingURL=intents.d.ts.map