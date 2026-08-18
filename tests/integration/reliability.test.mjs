/**
 * Reliability tests (docs/DISASTER_RECOVERY.md, PRD §14):
 *
 *   - concurrent `drift realize` processes cannot corrupt git or the store;
 *   - no temporary/lock files leak after any command;
 *   - a read-only/unwritable store fails SAFELY (actionable error) and the
 *     repo recovers once storage is restored;
 *   - the App queue schema migrates forward (old DB without the `signature`
 *     column still works — the worker's HMAC re-verification upgrade);
 *   - the documented backup/restore procedure (copy `.drift/`, restore it)
 *     round-trips private prompts and keys.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  cpSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = resolve(process.cwd(), "packages", "drift-cli", "dist", "cli.js");

function run(repo, args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function git(repo, args) {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "drift-reliab-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Test Dev"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

function listTree(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listTree(full, out);
    else out.push(full);
  }
  return out;
}

const LEAK_RE = /\.(tmp|lock|part|swp|swo|bak|orig|rej)$/;

test("concurrent `drift realize` processes: no corruption, consistent end state", async () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);

  const edit = (file, content) => {
    writeFileSync(join(repo, "src", file), content);
  };
  edit("a.ts", "export const a = 1;\n");
  const spawnRealize = (prompt, summary) =>
    new Promise((res) => {
      const c = spawn(
        process.execPath,
        [CLI, "realize", "-p", prompt, "--summary", summary, "--json"],
        { cwd: repo, env: { ...process.env, NO_COLOR: "1" } },
      );
      let out = "";
      let err = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (err += d));
      c.on("close", (code) => res({ code, out, err }));
    });

  edit("b.ts", "export const b = 1;\n");
  const [r1, r2] = await Promise.all([
    spawnRealize("Add feature B with validation", "Add feature B"),
    spawnRealize("Add feature C with tests", "Add feature C"),
  ]);

  // Exit codes first: if the hosted runner ever makes BOTH realize processes
  // fail, this assertion surfaces each child's stderr instead of hiding it.
  assert.ok(
    r1.code === 0 || r2.code === 0,
    `at least one realize must succeed (got ${r1.code}, ${r2.code}):\n-- r1.err --\n${r1.err}\n-- r2.err --\n${r2.err}`,
  );
  // Git must be coherent afterwards, no matter which process won.
  const fsck = spawnSync("git", ["fsck", "--strict"], { cwd: repo, encoding: "utf8" });
  assert.equal(fsck.status, 0, `git fsck failed: ${fsck.stderr}`);

  const log = run(repo, ["log", "--json"]);
  assert.equal(log.status, 0, `log failed: ${log.stderr}`);
  const parsed = JSON.parse(log.stdout);
  assert.ok(parsed.intents.length >= 1, "at least one intent recorded");
  // Either both landed or one won cleanly — but never a split/broken state.
  const status = run(repo, ["status", "--json"]);
  assert.equal(status.status, 0, `status failed: ${status.stderr}`);
});

test("no temporary/lock files leak after the full command surface", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "x.ts"), "export const x = 1;\n");
  assert.equal(run(repo, ["realize", "-p", "Add x", "--summary", "Add x"]).status, 0);
  const intentId = JSON.parse(run(repo, ["log", "--json"]).stdout).intents[0].id;
  for (const args of [
    ["log", "--json"],
    ["status", "--json"],
    ["context", "src/app.ts"],
    ["export", "--public", "--json"],
    ["doctor", "--json"],
    ["verify", intentId, "--json"],
    ["blame", "src/app.ts", "--line", "1"],
  ]) {
    const r = run(repo, args);
    assert.equal(r.status, 0, `${args.join(" ")} failed: ${r.stderr}`);
  }
  const leaks = listTree(repo).filter((p) => LEAK_RE.test(p));
  assert.deepEqual(leaks, [], `temporary files leaked: ${leaks.join(", ")}`);
});

test("unreadable store fails safely and backup-restore recovers", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "y.ts"), "export const y = 1;\n");
  assert.equal(run(repo, ["realize", "-p", "Add y", "--summary", "Add y"]).status, 0);

  // Backup the store, then simulate storage failure (an unwritable/unreadable
  // DB path — on POSIX this is what a read-only filesystem or disk-full state
  // looks like to SQLite; a directory in place of the DB is the portable way
  // to force the same "cannot open store" failure on Windows).
  const dbPath = join(repo, ".drift", "drift.db");
  const backupPath = `${dbPath}.bak`;
  writeFileSync(backupPath, readFileSync(dbPath));
  rmSync(dbPath, { force: true });
  mkdirSync(dbPath, { recursive: true });

  // Reading must fail SAFELY with an actionable error — never a hang, never a
  // silent success that pretends state it could not read.
  const log = run(repo, ["log", "--json"]);
  assert.notEqual(log.status, 0, "unreadable store must not silently succeed");
  assert.match(log.stdout + log.stderr, /corrupt|unreadable|permission|denied/i);

  // Restore from the backup (the documented disaster-recovery procedure).
  rmSync(dbPath, { recursive: true, force: true });
  writeFileSync(dbPath, readFileSync(backupPath));
  rmSync(backupPath, { force: true });
  const after = run(repo, ["log", "--json", "--include-private-prompt"]);
  assert.equal(after.status, 0, `log after restore failed: ${after.stderr}`);
  const parsed = JSON.parse(after.stdout);
  assert.ok(parsed.intents.length >= 1, "intent survived the storage failure");
  assert.equal(parsed.intents[0].prompt, "Add y");
});

test("App queue schema migrates forward (pre-signature DB keeps working)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const appDist = resolve(process.cwd(), "packages", "drift-app", "dist");
  const { SqliteQueue } = await import(pathToFileURL(join(appDist, "queue.js")).href);

  const dir = mkdtempSync(join(tmpdir(), "drift-queue-mig-"));
  const dbPath = join(dir, "queue.db");
  // Old schema: no `signature` column (as shipped before the worker
  // HMAC-re-verification upgrade).
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE webhook_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id TEXT NOT NULL UNIQUE,
    event TEXT NOT NULL,
    raw_body TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 8,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT NOT NULL DEFAULT '',
    last_error TEXT,
    last_result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`);
  // A legacy pre-migration job (no signature stored → fail closed in the worker).
  db.prepare(
    `INSERT INTO webhook_jobs (delivery_id, event, raw_body, payload_json, created_at, updated_at)
     VALUES (?, 'pull_request', '{}', '{}', 1, 1)`,
  ).run("legacy-delivery");
  db.close();

  // New code opens the old DB: the migration adds the column, and the legacy
  // row round-trips with an empty signature (worker treats it as unsigned).
  const queue = new SqliteQueue({ path: dbPath, maxAttempts: 3 });
  const claimed = await queue.claim(10, 1000, "w1");
  assert.equal(claimed.length, 1, "legacy job is claimable");
  assert.equal(claimed[0].signature, "", "legacy job has no stored signature");
  const enq = await queue.enqueue("new-delivery", "pull_request", "{}", {}, "sha256=abc");
  assert.equal(enq.accepted, true);
  const claimed2 = await queue.claim(10, 1000, "w2");
  const newJob = claimed2.find((j) => j.deliveryId === "new-delivery");
  assert.equal(newJob?.signature, "sha256=abc", "new jobs persist the signature");
  queue.close();

  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

test("documented backup/restore procedure round-trips keys and private prompts", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "z.ts"), "export const z = 1;\n");
  const prompt = "Refactor the auth module and rotate the session secret";
  const realize = run(repo, ["realize", "-p", prompt, "--summary", "Refactor auth"]);
  assert.equal(realize.status, 0, realize.stderr);

  // Backup: copy the whole .drift directory (private store + keys + DB).
  const backup = mkdtempSync(join(tmpdir(), "drift-backup-"));
  cpSync(join(repo, ".drift"), join(backup, ".drift"), { recursive: true });

  // Disaster: the local state is destroyed (fresh clone scenario).
  rmSync(join(repo, ".drift"), { recursive: true, force: true });
  assert.ok(!existsSync(join(repo, ".drift")));

  // Restore: copy the backup back.
  cpSync(join(backup, ".drift"), join(repo, ".drift"), { recursive: true });

  const log = run(repo, ["log", "--json", "--include-private-prompt"]);
  assert.equal(log.status, 0, `log after restore failed: ${log.stderr}`);
  const parsed = JSON.parse(log.stdout);
  assert.ok(parsed.intents.length >= 1, "intent restored");
  assert.ok(
    parsed.intents.some((e) => e.prompt === prompt),
    "private prompt round-tripped through backup/restore",
  );
  const status = run(repo, ["status", "--json"]);
  assert.equal(status.status, 0);
});
