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
/**
 * Absolute path of the git index file for a repository (`git rev-parse
 * --git-path index`). Falls back to plain `--git-path` on older git that
 * lacks `--path-format=absolute`.
 */
export declare function gitIndexPath(repoRoot: string): string | null;
/**
 * A BYTE-FOR-BYTE backup of the git index file taken BEFORE Drift stages
 * anything. Copying the actual index file (not a tree, not a cached diff)
 * preserves every bit of staged state exactly: partially staged hunks,
 * intent-to-add entries, renames, deletions, mode changes, assume-unchanged /
 * skip-worktree flags and conflict stages — a `git write-tree`/`read-tree`
 * round-trip or a patch replay cannot guarantee all of that.
 *
 * `backupPath` is null when NO index existed before Drift (a fresh repo with
 * nothing staged) — restoring then means removing the index Drift created.
 */
export interface IndexSnapshot {
    backupPath: string | null;
}
export declare function captureIndexSnapshot(repoRoot: string): IndexSnapshot;
/**
 * Restore the index captured by `captureIndexSnapshot`. Safe to call once;
 * a second call is a no-op (the backup directory is removed by the first
 * restore). Never overwrites another git process's lock; never touches the
 * worktree.
 */
export declare function restoreIndexSnapshot(repoRoot: string, snap: IndexSnapshot): void;
/**
 * Discard a captured index snapshot WITHOUT restoring it (successful commit
 * path). Removes the temporary backup directory so no `drift-idx-*` residue
 * survives on disk — including on a persistent self-hosted runner.
 */
export declare function discardIndexSnapshot(repoRoot: string, snap: IndexSnapshot): void;
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
/**
 * Commit sha owning each line in [startLine, endLine] of a file
 * (`git blame -L start,end --line-porcelain`). The porcelain header repeats
 * per line: `<sha> <origLine> <finalLine> [<count>]`, so final line → sha is
 * parsed directly. Used by `blame --function` to attribute the intent that
 * touched ANY line of a function's body, not just its signature line.
 */
export declare function blameLines(repoRoot: string, filePath: string, startLine: number, endLine: number): Map<number, string>;
export declare function checkout(repoRoot: string, sha: string): void;
export declare function gitLogMessages(repoRoot: string): {
    sha: string;
    body: string;
}[];
export { existsSync, readFileSync, execFileSync };
//# sourceMappingURL=git.d.ts.map