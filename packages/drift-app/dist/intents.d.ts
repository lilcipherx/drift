/**
 * Read `Drift-Intent: <id>` trailers from pull request commits and hydrate the
 * intent objects from `.drift/objects/` at the PR head (PRD §16.2).
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
    prompt: string;
    encryptedPrompt: boolean;
    verifyCmd: string | null;
    files: IntentFileView[];
    signature: boolean;
}
/** Extract unique intent ids referenced by a set of commits (order preserved). */
export declare function extractIntentIds(commits: PullCommit[]): string[];
/**
 * Decrypt an `encv1:` prompt when DRIFT_MASTER_KEY is available. `aad` must
 * match the intent id the payload was bound to at realize time.
 */
export declare function decryptPrompt(prompt: string, masterKeyEnv?: string, aad?: string): {
    prompt: string;
    encrypted: boolean;
};
/**
 * Load the intent objects referenced by a PR. Falls back to the commit
 * message subject as the prompt when the object is missing (e.g. `.drift`
 * not committed).
 */
export declare function fetchIntents(github: GitHubClientLike, owner: string, repo: string, ref: string, commits: PullCommit[], ids: string[], masterKeyEnv?: string): Promise<IntentView[]>;
//# sourceMappingURL=intents.d.ts.map