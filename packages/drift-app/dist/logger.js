/**
 * Structured operational logging for the Drift App and workers.
 *
 * Every line is a single JSON object with bounded, privacy-safe fields:
 * delivery id, installation id, repository (owner/name), operation, duration,
 * result, retry count and a bounded error code. Logs NEVER contain prompt
 * text, private manifest data, tokens, webhook secrets, authorization
 * headers, private keys, or child-process environments.
 */
/** Never log raw payloads, bodies, secrets, or arbitrary error strings. */
const SAFE_KEYS = new Set([
    "deliveryId",
    "installationId",
    "repo",
    "op",
    "durationMs",
    "result",
    "retryCount",
    "errorCode",
    "msg",
    "queueDepth",
    "rateLimitRemaining",
]);
export function createLogger(opts = {}) {
    const levelRank = { debug: 0, info: 1, warn: 2, error: 3 };
    const minRank = levelRank[opts.level ?? "info"] ?? 1;
    const sink = opts.sink ?? ((line) => process.stdout.write(`${line}\n`));
    const emit = (level, fields) => {
        if (levelRank[level] < minRank)
            return;
        const record = { ts: new Date().toISOString(), level };
        for (const [k, v] of Object.entries(fields)) {
            if (!SAFE_KEYS.has(k))
                continue;
            if (v === undefined)
                continue;
            record[k] = v;
        }
        try {
            sink(JSON.stringify(record));
        }
        catch {
            sink(JSON.stringify({ ts: new Date().toISOString(), level, op: "log", errorCode: "log-serialize-failed" }));
        }
    };
    return {
        debug: (f) => emit("debug", f),
        info: (f) => emit("info", f),
        warn: (f) => emit("warn", f),
        error: (f) => emit("error", f),
    };
}
/** Silent logger (tests). */
export const nullLogger = {
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { },
};
//# sourceMappingURL=logger.js.map