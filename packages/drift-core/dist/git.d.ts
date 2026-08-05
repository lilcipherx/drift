/**
 * Git integration (PRD §10). Drift wraps git via the CLI — never rewrites
 * history, never touches `.git` internals. Trailers are the only footprint.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
export interface GitResult {
    status: number;
    stdout: string;
    stderr: string;
}
export declare function execGit(repoRoot: string, args: string[], allowFailure?: boolean): GitResult;
/** Find the git repository root containing `cwd` (or `DRIFT_REPO`). */
export declare function findRepoRoot(cwd: string, envRepo?: string): string | null;
export declare function currentHead(repoRoot: string): string | null;
export declare function commitExists(repoRoot: string, sha: string): boolean;
export declare function gitIdentity(repoRoot: string, key: "user.name" | "user.email"): string;
/** Stage all changes except Drift's own metadata (`.drift/`). */
export declare function stageAll(repoRoot: string, files?: string[]): void;
export declare function unstage(repoRoot: string): void;
export interface StagedFile {
    status: string;
    path: string;
}
/** `git diff --cached --name-status -z` — robust against spaces/newlines in paths. */
export declare function stagedNameStatus(repoRoot: string): StagedFile[];
/** Read a file's content at a ref (e.g. HEAD). Returns null if absent there. */
export declare function readFileAt(repoRoot: string, path: string, ref: string): string | null;
export declare function commit(repoRoot: string, message: string): string;
/** Commit sha owning the given line of a file (porcelain blame). */
export declare function blameLine(repoRoot: string, filePath: string, line: number): string;
export declare function checkout(repoRoot: string, sha: string): void;
export declare function gitLogMessages(repoRoot: string): {
    sha: string;
    body: string;
}[];
export { existsSync, readFileSync, execFileSync };
//# sourceMappingURL=git.d.ts.map