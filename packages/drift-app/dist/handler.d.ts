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