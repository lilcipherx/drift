/**
 * Git integration (PRD §10). Drift wraps git via the CLI — never rewrites
 * history, never touches `.git` internals. Trailers are the only footprint.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
export function unstage(repoRoot) {
    execGit(repoRoot, ["reset"], true);
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
    const res = execGit(repoRoot, ["blame", "-L", `${line},${line}`, "--porcelain", "--", filePath], true);
    if (res.status !== 0) {
        throw new DriftError(`git blame failed for ${filePath}:${line}: ${res.stderr.trim()}`);
    }
    const firstLine = res.stdout.split("\n")[0] ?? "";
    const sha = firstLine.split(" ")[0] ?? "";
    return /^[0-9a-f]{40}$/.test(sha) ? sha : "";
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