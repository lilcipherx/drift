/**
 * HTTP webhook server (PRD §16.3 "drift-app dev"): receives GitHub deliveries
 * on POST /webhook, verifies the HMAC signature, and delegates to the handler.
 */
import { type IncomingMessage, type ServerResponse } from "node:http";
import { type WebhookDeps } from "./handler.js";
export interface ServerOptions extends WebhookDeps {
    port: number;
    host?: string;
    log?: (line: string) => void;
    /** Max accepted webhook body size in bytes (default 1 MB). */
    maxBodyBytes?: number;
    /** Grace for in-flight requests on close() before force-close (ms). */
    closeGraceMs?: number;
}
/**
 * Fail-closed startup: a production webhook endpoint MUST authenticate
 * deliveries. `DRIFT_APP_INSECURE_DEV_MODE` (exactly "true") is the only
 * way to run without a secret and it must be explicit and loud.
 */
export declare function assertWebhookAuthConfigured(webhookSecret: string | undefined, insecureDevMode: string | undefined): {
    webhookSecret: string | undefined;
    insecureDevMode: boolean;
};
export declare function createWebhookServer(opts: ServerOptions): Promise<{
    server: import("http").Server<typeof IncomingMessage, typeof ServerResponse>;
    port: number;
    close: () => Promise<void>;
}>;
//# sourceMappingURL=server.d.ts.map