/**
 * pull_request webhook handler (PRD §16.2).
 *
 * On `opened`/`synchronize`/`reopened`:
 *   1. read `Drift-Intent` trailers from the PR commits;
 *   2. hydrate intent objects from `.drift/objects/` at the PR head;
 *   3. post a semantic summary comment and a check run.
 *
 * Idempotent: the summary embeds an invisible `SUMMARY_MARKER`; if a Drift
 * comment already exists on the PR it is updated in place, so repeated
 * deliveries (GitHub webhook retries, `synchronize` pushes) never stack
 * duplicate comments.
 */
import type { GitHubClientLike } from "./github.js";
export interface WebhookDeps {
    github: GitHubClientLike;
    /** HMAC webhook secret (X-Hub-Signature-256). Undefined ⇒ skip verification. */
    webhookSecret?: string;
    /** Disable check-run creation (comment-only mode). */
    checkRun?: boolean;
    /** Build the summary without writing anything (dev --dry-run). */
    readOnly?: boolean;
}
export interface WebhookResult {
    handled: boolean;
    action: "commented" | "updated" | "no-intents" | "skipped" | "error" | "dry-run";
    commentBody?: string;
    intentsFound: number;
    error?: string;
    /** False for client-side errors (GitHub must not retry). */
    retryable?: boolean;
}
export interface WebhookEvent {
    event: string;
    signature?: string;
    payload: Record<string, unknown>;
    rawBody: string;
}
export declare function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string): boolean;
export declare function handleWebhook(event: WebhookEvent, deps: WebhookDeps): Promise<WebhookResult>;
//# sourceMappingURL=handler.d.ts.map