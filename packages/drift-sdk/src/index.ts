/**
 * Drift SDK — a small, typed, validated client over the engine.
 * Use it to build agent integrations (MCP tools, bots, CI).
 */

import {
  Drift as Engine,
  DriftError,
  EXIT,
  type BlameResult,
  type LogEntry,
  type RealizeResult,
  type VerifyResult,
} from "@drift/core";
import {
  BlameRequestSchema,
  ContextRequestSchema,
  IntentSchema,
  LogRequestSchema,
  RealizeRequestSchema,
} from "./schema.js";
import type {
  BlameRequest,
  ContextRequest,
  LogRequest,
  RealizeRequest,
} from "./schema.js";

export type {
  ASTDelta,
  Author,
  Intent,
  RealizeRequest,
  BlameRequest,
  ContextRequest,
  LogRequest,
} from "./schema.js";
export { IntentSchema } from "./schema.js";

export interface DriftOptions {
  /** Repository root. Defaults to DRIFT_REPO env or CWD. */
  repo?: string;
}

export class Drift {
  private engine: Engine;

  private constructor(engine: Engine) {
    this.engine = engine;
  }

  /** Open an existing drift repository. */
  static open(opts: DriftOptions = {}): Drift {
    const engine = Engine.fromCwd(opts.repo ?? process.cwd());
    return new Drift(engine);
  }

  /** Initialize drift metadata in the current repo. */
  static init(cwd = process.cwd()): string {
    const result = Engine.init(cwd);
    return result.driftDir;
  }

  /** Commit changes with intent (rejects broken syntax, exit 2). */
  realize(req: RealizeRequest): RealizeResult {
    const input = RealizeRequestSchema.parse(req);
    return this.engine.realize(input);
  }

  /** List intents with filters. */
  log(req: LogRequest = {}): LogEntry[] {
    const input = LogRequestSchema.parse(req);
    return this.engine.log(input);
  }

  /** Why does this line/function exist? */
  blame(req: BlameRequest): BlameResult {
    const input = BlameRequestSchema.parse(req);
    return this.engine.blame(input.file, {
      line: input.line,
      functionName: input.functionName,
    });
  }

  /** Hydrate reasoning: last N intents touching a file. */
  context(req: ContextRequest): LogEntry[] {
    const input = ContextRequestSchema.parse(req);
    return this.engine.context(input.file, input.limit ?? 5);
  }

  /** Re-run the verification command recorded in an intent. */
  verify(intentId: string): VerifyResult {
    return this.engine.verify(intentId);
  }

  /** Restore a prior cognitive state (optionally checking out its commit). */
  replay(intentId: string, checkout = false) {
    return this.engine.replay(intentId, { checkout });
  }

  /** Validate an intent record against the Zod schema. */
  static validateIntent(data: unknown): boolean {
    return IntentSchema.safeParse(data).success;
  }

  close(): void {
    this.engine.close();
  }
}

export { DriftError, EXIT };
