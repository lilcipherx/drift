/**
 * Git integration (PRD §10). Drift wraps git via the CLI — never rewrites
 * history, never touches `.git` internals. Trailers are the only footprint.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DriftError } from "./errors.js";
export function execGit(repoRoot, args, allowFailure = false) {
    const res = spawnSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
    });
    if (!allowFailure && res.status !== 0) {
        throw new DriftError(`git ${args.join(" ")} failed: ${(res.stderr || res.stdout).trim()}`);
    }
    return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
/** Find the git repository root containing `cwd` (or `DRIFT_REPO`). */
export function findRepoRoot(cwd, envRepo) {
    if (envRepo) {
        const abs = resolve(envRepo);
        if (existsSync(join(abs, ".git")))
            return abs;
        return null;
    }
    let dir = resolve(cwd);
    for (;;) {
        if (existsSync(join(dir, ".git")))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
export function currentHead(repoRoot) {
    const res = execGit(repoRoot, ["rev-parse", "HEAD"], true);
    if (res.status !== 0)
        return null;
    const sha = res.stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}
export function commitExists(repoRoot, sha) {
    const res = execGit(repoRoot, ["cat-file", "-e", `${sha}^{commit}`], true);
    return res.status === 0;
}
export function gitIdentity(repoRoot, key) {
    const res = execGit(repoRoot, ["config", "--get", key], true);
    return res.status === 0 ? res.stdout.trim() : "";
}
/** Stage all changes except Drift's own metadata (`.drift/`). */
export function stageAll(repoRoot, files) {
    if (files && files.length > 0) {
        execGit(repoRoot, ["add", "--", ...files]);
        return;
    }
    execGit(repoRoot, ["add", "-A", "--", ".", ":(exclude).drift"]);
}
// ---------------------------------------------------------------------------
// Index snapshot / restore — Drift must never destroy the user's staged state
// ---------------------------------------------------------------------------
/**
 * Absolute path of the git index file for a repository (`git rev-parse
 * --git-path index`). Falls back to plain `--git-path` on older git that
 * lacks `--path-format=absolute`.
 */
export function gitIndexPath(repoRoot) {
    const abs = execGit(repoRoot, ["rev-parse", "--path-format=absolute", "--git-path", "index"], true);
    if (abs.status === 0 && abs.stdout.trim())
        return abs.stdout.trim();
    const plain = execGit(repoRoot, ["rev-parse", "--git-path", "index"], true);
    if (plain.status !== 0 || !plain.stdout.trim())
        return null;
    const p = plain.stdout.trim();
    return resolve(repoRoot, p);
}
function indexLockExists(repoRoot) {
    const indexPath = gitIndexPath(repoRoot);
    if (!indexPath)
        return null;
    const lockPath = `${indexPath}.lock`;
    return existsSync(lockPath) ? lockPath : null;
}
export function captureIndexSnapshot(repoRoot) {
    const indexPath = gitIndexPath(repoRoot);
    if (!indexPath) {
        throw new DriftError("cannot determine the git index path — is this a git repository?");
    }
    const lock = indexLockExists(repoRoot);
    if (lock) {
        throw new DriftError(`git index.lock exists (${lock}) — another git process may be running. Wait for it to finish, then run drift realize again.`);
    }
    if (!existsSync(indexPath))
        return { backupPath: null };
    const dir = mkdtempSync(join(tmpdir(), "drift-idx-"));
    const backupPath = join(dir, "index");
    copyFileSync(indexPath, backupPath);
    return { backupPath };
}
/**
 * Restore the index captured by `captureIndexSnapshot`. Safe to call once;
 * a second call is a no-op (the backup directory is removed by the first
 * restore). Never overwrites another git process's lock; never touches the
 * worktree.
 */
export function restoreIndexSnapshot(repoRoot, snap) {
    const indexPath = gitIndexPath(repoRoot);
    if (!indexPath)
        return; // repo vanished mid-operation — nothing we can do
    const lock = indexLockExists(repoRoot);
    if (lock) {
        throw new DriftError(`git index.lock exists (${lock}) — cannot restore the index while another git process is running. Drift's staging was NOT rolled back.`);
    }
    if (!snap.backupPath) {
        // No index existed before Drift — remove the one Drift's git commands
        // created so the repository is byte-identical to the pre-Drift state.
        if (existsSync(indexPath))
            rmSync(indexPath, { force: true });
        return;
    }
    if (!existsSync(snap.backupPath))
        return; // already restored / already discarded
    // Atomic replace in the same directory (fs.rename replaces atomically on
    // POSIX and Windows). Never a plain overwrite of a live index.
    const tmp = `${indexPath}.drift-restore-${process.pid}`;
    copyFileSync(snap.backupPath, tmp);
    renameSync(tmp, indexPath);
    try {
        rmSync(dirname(snap.backupPath), { recursive: true, force: true });
    }
    catch {
        /* best-effort cleanup */
    }
}
/**
 * Discard a captured index snapshot WITHOUT restoring it (successful commit
 * path). Removes the temporary backup directory so no `drift-idx-*` residue
 * survives on disk — including on a persistent self-hosted runner.
 */
export function discardIndexSnapshot(repoRoot, snap) {
    void repoRoot;
    if (!snap.backupPath)
        return;
    try {
        rmSync(dirname(snap.backupPath), { recursive: true, force: true });
    }
    catch {
        /* best-effort cleanup */
    }
}
/** `git diff --cached --name-status -z` — robust against spaces/newlines in paths. */
export function stagedNameStatus(repoRoot) {
    const res = execGit(repoRoot, ["diff", "--cached", "--name-status", "-z"], true);
    if (res.status !== 0)
        return [];
    const parts = res.stdout.split("\0").filter((p) => p.length > 0);
    const out = [];
    let i = 0;
    while (i < parts.length) {
        const rawStatus = parts[i];
        const status = rawStatus[0];
        if (status === "R") {
            const oldPath = parts[i + 1];
            const newPath = parts[i + 2];
            if (oldPath !== undefined && newPath !== undefined) {
                out.push({ status: "R", path: newPath });
                out.push({ status: "D", path: oldPath });
            }
            i += 3;
        }
        else {
            const path = parts[i + 1];
            if (path !== undefined)
                out.push({ status, path });
            i += 2;
        }
    }
    return out;
}
/** Read a file's content at a ref (e.g. HEAD). Returns null if absent there. */
export function readFileAt(repoRoot, path, ref) {
    const res = execGit(repoRoot, ["show", `${ref}:${path}`], true);
    if (res.status !== 0)
        return null;
    return res.stdout;
}
export function commit(repoRoot, message) {
    const res = execGit(repoRoot, ["commit", "-m", message]);
    const sha = currentHead(repoRoot);
    if (!sha)
        throw new DriftError("git commit reported success but HEAD is empty");
    return sha;
}
/** Commit sha owning the given line of a file (porcelain blame). */
export function blameLine(repoRoot, filePath, line) {
    return blameLines(repoRoot, filePath, line, line).get(line) ?? "";
}
/**
 * Commit sha owning each line in [startLine, endLine] of a file
 * (`git blame -L start,end --line-porcelain`). The porcelain header repeats
 * per line: `<sha> <origLine> <finalLine> [<count>]`, so final line → sha is
 * parsed directly. Used by `blame --function` to attribute the intent that
 * touched ANY line of a function's body, not just its signature line.
 */
export function blameLines(repoRoot, filePath, startLine, endLine) {
    const res = execGit(repoRoot, [
        "blame",
        "-L",
        `${startLine},${endLine}`,
        "--line-porcelain",
        "--",
        filePath,
    ], true);
    if (res.status !== 0) {
        throw new DriftError(`git blame failed for ${filePath}:${startLine}-${endLine}: ${res.stderr.trim()}`);
    }
    const out = new Map();
    // git can prefix boundary (root) commits with `^` in blame output on some
    // versions — tolerate it so a missed line never turns a resolvable baseline
    // into a thrown "Could not blame".
    const headerRe = /^\^?([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;
    for (const line of res.stdout.split("\n")) {
        const m = headerRe.exec(line);
        if (m)
            out.set(Number(m[3]), m[1]);
    }
    return out;
}
export function checkout(repoRoot, sha) {
    execGit(repoRoot, ["checkout", sha]);
}
export function gitLogMessages(repoRoot) {
    const res = execGit(repoRoot, ["log", "--format=%H%x00%B%x01", "--no-color"], true);
    if (res.status !== 0 || !res.stdout)
        return [];
    const out = [];
    for (const entry of res.stdout.split("\x01")) {
        const sep = entry.indexOf("\x00");
        if (sep === -1)
            continue;
        const sha = entry.slice(0, sep).trim();
        const body = entry.slice(sep + 1);
        if (/^[0-9a-f]{40}$/.test(sha))
            out.push({ sha, body });
    }
    return out;
}
export { existsSync, readFileSync, execFileSync };
//# sourceMappingURL=git.js.map