/**
 * Git integration (PRD §10). Drift wraps git via the CLI — never rewrites
 * history, never touches `.git` internals. Trailers are the only footprint.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DriftError } from "./errors.js";

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function execGit(repoRoot: string, args: string[], allowFailure = false): GitResult {
  const res = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (!allowFailure && res.status !== 0) {
    throw new DriftError(
      `git ${args.join(" ")} failed: ${(res.stderr || res.stdout).trim()}`,
    );
  }
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Find the git repository root containing `cwd` (or `DRIFT_REPO`). */
export function findRepoRoot(cwd: string, envRepo?: string): string | null {
  if (envRepo) {
    const abs = resolve(envRepo);
    if (existsSync(join(abs, ".git"))) return abs;
    return null;
  }
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function currentHead(repoRoot: string): string | null {
  const res = execGit(repoRoot, ["rev-parse", "HEAD"], true);
  if (res.status !== 0) return null;
  const sha = res.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export function commitExists(repoRoot: string, sha: string): boolean {
  const res = execGit(repoRoot, ["cat-file", "-e", `${sha}^{commit}`], true);
  return res.status === 0;
}

export function gitIdentity(repoRoot: string, key: "user.name" | "user.email"): string {
  const res = execGit(repoRoot, ["config", "--get", key], true);
  return res.status === 0 ? res.stdout.trim() : "";
}

/** Stage all changes except Drift's own metadata (`.drift/`). */
export function stageAll(repoRoot: string, files?: string[]): void {
  if (files && files.length > 0) {
    execGit(repoRoot, ["add", "--", ...files]);
    return;
  }
  execGit(repoRoot, ["add", "-A", "--", ".", ":(exclude).drift"]);
}

export function unstage(repoRoot: string): void {
  execGit(repoRoot, ["reset"], true);
}

export interface StagedFile {
  status: string; // A / M / D / R
  path: string;
}

/** `git diff --cached --name-status -z` — robust against spaces/newlines in paths. */
export function stagedNameStatus(repoRoot: string): StagedFile[] {
  const res = execGit(repoRoot, ["diff", "--cached", "--name-status", "-z"], true);
  if (res.status !== 0) return [];
  const parts = res.stdout.split("\0").filter((p) => p.length > 0);
  const out: StagedFile[] = [];
  let i = 0;
  while (i < parts.length) {
    const rawStatus = parts[i]!;
    const status = rawStatus[0]!;
    if (status === "R") {
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      if (oldPath !== undefined && newPath !== undefined) {
        out.push({ status: "R", path: newPath });
        out.push({ status: "D", path: oldPath });
      }
      i += 3;
    } else {
      const path = parts[i + 1];
      if (path !== undefined) out.push({ status, path });
      i += 2;
    }
  }
  return out;
}

/** Read a file's content at a ref (e.g. HEAD). Returns null if absent there. */
export function readFileAt(repoRoot: string, path: string, ref: string): string | null {
  const res = execGit(repoRoot, ["show", `${ref}:${path}`], true);
  if (res.status !== 0) return null;
  return res.stdout;
}

export function commit(repoRoot: string, message: string): string {
  const res = execGit(repoRoot, ["commit", "-m", message]);
  const sha = currentHead(repoRoot);
  if (!sha) throw new DriftError("git commit reported success but HEAD is empty");
  return sha;
}

/** Commit sha owning the given line of a file (porcelain blame). */
export function blameLine(repoRoot: string, filePath: string, line: number): string {
  return blameLines(repoRoot, filePath, line, line).get(line) ?? "";
}

/**
 * Commit sha owning each line in [startLine, endLine] of a file
 * (`git blame -L start,end --line-porcelain`). The porcelain header repeats
 * per line: `<sha> <origLine> <finalLine> [<count>]`, so final line → sha is
 * parsed directly. Used by `blame --function` to attribute the intent that
 * touched ANY line of a function's body, not just its signature line.
 */
export function blameLines(
  repoRoot: string,
  filePath: string,
  startLine: number,
  endLine: number,
): Map<number, string> {
  const res = execGit(
    repoRoot,
    [
      "blame",
      "-L",
      `${startLine},${endLine}`,
      "--line-porcelain",
      "--",
      filePath,
    ],
    true,
  );
  if (res.status !== 0) {
    throw new DriftError(
      `git blame failed for ${filePath}:${startLine}-${endLine}: ${res.stderr.trim()}`,
    );
  }
  const out = new Map<number, string>();
  const headerRe = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;
  for (const line of res.stdout.split("\n")) {
    const m = headerRe.exec(line);
    if (m) out.set(Number(m[3]), m[1]!);
  }
  return out;
}

export function checkout(repoRoot: string, sha: string): void {
  execGit(repoRoot, ["checkout", sha]);
}

export function gitLogMessages(repoRoot: string): { sha: string; body: string }[] {
  const res = execGit(
    repoRoot,
    ["log", "--format=%H%x00%B%x01", "--no-color"],
    true,
  );
  if (res.status !== 0 || !res.stdout) return [];
  const out: { sha: string; body: string }[] = [];
  for (const entry of res.stdout.split("\x01")) {
    const sep = entry.indexOf("\x00");
    if (sep === -1) continue;
    const sha = entry.slice(0, sep).trim();
    const body = entry.slice(sep + 1);
    if (/^[0-9a-f]{40}$/.test(sha)) out.push({ sha, body });
  }
  return out;
}

export { existsSync, readFileSync, execFileSync };
