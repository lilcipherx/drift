/**
 * pull_request webhook handler (PRD §16.2).
 *
 * On `opened`/`synchronize`/`reopened`:
 *   1. verify the webhook HMAC — FAIL CLOSED: production requires a webhook
 *      secret; only an explicit `DRIFT_APP_INSECURE_DEV_MODE=true` allows
 *      unsigned requests (loudly warned, local development only);
 *   2. evaluate the trust root (base vs head `.drift/public/key.pem`) BEFORE
 *      any \"no intents\" early return — a key-only PR must never be invisible;
 *   3. read `Drift-Intent:` trailers from the PR commits and hydrate strictly
 *      validated public manifests (`.drift/public/intents/`);
 *   4. derive the Check Run conclusion from the shared policy
 *      (`deriveProvenanceConclusion`) — never unconditional success;
 *   5. post/update the summary comment, updating ONLY ownership-verified
 *      Drift comments (spoofed user-authored markers are never touched).
 *
 * Private data (prompts, `objects/`, `drift.db`) is never read or rendered.
 */
import type { GitHubClientLike } from "./github.js";
export interface WebhookDeps {
    github: GitHubClientLike;
    /** HMAC webhook secret (X-Hub-Signature-256). Required in production. */
    webhookSecret?: string;
    /** Explicit insecure development mode (must be exactly \"true\"). */
    insecureDevMode?: boolean;
    /** Disable check-run creation (comment-only mode). */
    checkRun?: boolean;
    /** Build the summary without writing anything (dev --dry-run). */
    readOnly?: boolean;
    /**
     * The configured Drift GitHub App id, used for EXACT comment ownership
     * matching (performed_via_github_app.id must equal this). When absent, no
     * comment is treated as owned (fail-safe: never PATCH a possibly-foreign
     * comment).
     */
    appId?: string;
}
export interface WebhookResult {
    handled: boolean;
    action: "commented" | "updated" | "no-intents" | "key-change" | "skipped" | "error" | "dry-run";
    commentBody?: string;
    intentsFound: number;
    conclusion?: "success" | "neutral" | "failure";
    error?: string;
    /** False for client-side errors (GitHub must not retry). */
    retryable?: boolean;
    /** Structured Check Run + comment write outcomes for this delivery. */
    writeResult?: GitHubWriteResult;
}
export interface WebhookEvent {
    event: string;
    signature?: string;
    payload: Record<string, unknown>;
    rawBody: string;
}
export declare function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string): boolean;
export declare function handleWebhook(event: WebhookEvent, deps: WebhookDeps): Promise<WebhookResult>;
/**
 * Structured write outcomes for one webhook delivery. The Check Run is the
 * PRIMARY machine-readable trust result: a failed check run must never be
 * hidden by a successful comment, and vice versa. Transient API failures
 * (network/5xx/429) are `retryable` — the webhook then returns 500 so GitHub
 * redelivers — while permanent 4xx failures are acknowledged to stop retries.
 */
export type GitHubWriteResult = {
    checkRun: {
        state: "success";
        id: number;
    } | {
        state: "skipped";
        reason: string;
    } | {
        state: "failed";
        retryable: boolean;
        status?: number;
    };
    comment: {
        state: "success";
        id: number;
        action: "updated" | "commented";
    } | {
        state: "skipped";
        reason: string;
    } | {
        state: "failed";
        retryable: boolean;
        status?: number;
    };
};
//# sourceMappingURL=handler.d.ts.map