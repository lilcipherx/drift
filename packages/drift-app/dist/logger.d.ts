/**
 * Structured operational logging for the Drift App and workers.
 *
 * Every line is a single JSON object with bounded, privacy-safe fields:
 * delivery id, installation id, repository (owner/name), operation, duration,
 * result, retry count and a bounded error code. Logs NEVER contain prompt
 * text, private manifest data, tokens, webhook secrets, authorization
 * headers, private keys, or child-process environments.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogFields {
    /** GitHub webhook delivery GUID. */
    deliveryId?: string;
    /** GitHub App installation id (an opaque integer — safe to log). */
    installationId?: number | string;
    /** Repository in the "owner/name" form (public metadata). */
    repo?: string;
    /** Operation name (e.g. "webhook.receive", "job.process"). */
    op?: string;
    /** Duration in milliseconds. */
    durationMs?: number;
    /** Outcome (e.g. "accepted", "processed", "retrying", "dead", "error"). */
    result?: string;
    /** Worker retry count for the job. */
    retryCount?: number;
    /** Bounded machine-readable error code (never the full message when it may
     *  contain secrets — callers pass an already-safe code). */
    errorCode?: string;
    /** Free-form message (must be static or already sanitized). */
    msg?: string;
    /** Queue depth at the time of the event (ops metrics). */
    queueDepth?: number;
    /** GitHub API rate-limit remaining for the installation (metrics). */
    rateLimitRemaining?: number;
}
export interface Logger {
    debug(fields: LogFields): void;
    info(fields: LogFields): void;
    warn(fields: LogFields): void;
    error(fields: LogFields): void;
}
export declare function createLogger(opts?: {
    level?: LogLevel;
    sink?: (line: string) => void;
}): Logger;
/** Silent logger (tests). */
export declare const nullLogger: Logger;
//# sourceMappingURL=logger.d.ts.map