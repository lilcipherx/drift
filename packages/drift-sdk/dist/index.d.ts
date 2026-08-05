/**
 * Drift SDK — a small, typed, validated client over the engine.
 * Use it to build agent integrations (MCP tools, bots, CI).
 */
import { DriftError, EXIT, type BlameResult, type LogEntry, type RealizeResult, type VerifyResult } from "@drift/core";
import type { BlameRequest, ContextRequest, LogRequest, RealizeRequest } from "./schema.js";
export type { ASTDelta, Author, Intent, RealizeRequest, BlameRequest, ContextRequest, LogRequest, } from "./schema.js";
export { IntentSchema } from "./schema.js";
export interface DriftOptions {
    /** Repository root. Defaults to DRIFT_REPO env or CWD. */
    repo?: string;
}
export declare class Drift {
    private engine;
    private constructor();
    /** Open an existing drift repository. */
    static open(opts?: DriftOptions): Drift;
    /** Initialize drift metadata in the current repo. */
    static init(cwd?: string): string;
    /** Commit changes with intent (rejects broken syntax, exit 2). */
    realize(req: RealizeRequest): RealizeResult;
    /** List intents with filters. */
    log(req?: LogRequest): LogEntry[];
    /** Why does this line/function exist? */
    blame(req: BlameRequest): BlameResult;
    /** Hydrate reasoning: last N intents touching a file. */
    context(req: ContextRequest): LogEntry[];
    /** Re-run the verification command recorded in an intent. */
    verify(intentId: string): VerifyResult;
    /** Restore a prior cognitive state (optionally checking out its commit). */
    replay(intentId: string, checkout?: boolean): import("@drift/core").ReplayResult;
    /** Validate an intent record against the Zod schema. */
    static validateIntent(data: unknown): boolean;
    close(): void;
}
export { DriftError, EXIT };
//# sourceMappingURL=index.d.ts.map