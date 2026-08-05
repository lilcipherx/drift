/** Exit codes (PRD §14.1): 0 ok, 1 generic, 2 syntax/AST, 3 no changes, 4 missing key, 5 corrupt DAG. */
export declare const EXIT: {
    readonly OK: 0;
    readonly ERROR: 1;
    readonly SYNTAX: 2;
    readonly NO_CHANGES: 3;
    readonly KEY: 4;
    readonly CORRUPT: 5;
};
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
export declare class DriftError extends Error {
    readonly exitCode: ExitCode;
    constructor(message: string, exitCode?: ExitCode);
}
export declare class NotInitializedError extends DriftError {
    constructor();
}
//# sourceMappingURL=errors.d.ts.map