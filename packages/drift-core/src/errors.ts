/** Exit codes (PRD §14.1): 0 ok, 1 generic, 2 syntax/AST, 3 no changes, 4 missing key, 5 corrupt DAG. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  SYNTAX: 2,
  NO_CHANGES: 3,
  KEY: 4,
  CORRUPT: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class DriftError extends Error {
  readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode = EXIT.ERROR) {
    super(message);
    this.name = "DriftError";
    this.exitCode = exitCode;
  }
}

export class NotInitializedError extends DriftError {
  constructor() {
    super(
      "Not a Drift repository. Run `drift init` in the repository root first.",
    );
    this.name = "NotInitializedError";
  }
}
