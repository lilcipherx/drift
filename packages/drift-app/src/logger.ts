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

export function createLogger(opts: { level?: LogLevel; sink?: (line: string) => void } = {}): Logger {
  const levelRank: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const minRank = levelRank[opts.level ?? "info"] ?? 1;
  const sink = opts.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (level: LogLevel, fields: LogFields) => {
    if (levelRank[level] < minRank) return;
    const record: Record<string, unknown> = { ts: new Date().toISOString(), level };
    for (const [k, v] of Object.entries(fields)) {
      if (!SAFE_KEYS.has(k)) continue;
      if (v === undefined) continue;
      record[k] = v;
    }
    try {
      sink(JSON.stringify(record));
    } catch {
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
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
