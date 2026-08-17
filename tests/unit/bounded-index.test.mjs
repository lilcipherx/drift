/**
 * Bounded log/context + stat-validated public-manifest index (PRD §7).
 *
 * Proves:
 *   - `log --limit N` and `context` never materialize every manifest
 *     (bounded selection identical to the full scan on the same repo);
 *   - fresh-clone (no private store) heap fallback == index-backed results;
 *   - the index refreshes on new / changed / deleted / malformed /
 *     oversized manifest files;
 *   - a POISONED index (valid flag flipped directly in SQLite) can never
 *     inject a malformed manifest into log output — selected files are
 *     always re-read and re-validated from disk;
 *   - status/doctor keep re-verifying the full tree from files, so the
 *     index is never a trust source;
 *   - schema version bumps drop and rebuild the index.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const coreDist = resolve(ROOT, "packages", "drift-core", "dist", "index.js");
const { Drift } = await import(pathToFileURL(coreDist).href);

const did = (i) => `did_${i.toString(16).padStart(32, "0")}`;

function git(repo, args) {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function manifest(i, { file = "src/app.ts", author = "alice", model } = {}) {
  return JSON.stringify({
    schemaVersion: 2,
    id: did(i),
    summary: `summary ${i}`,
    timestamp: 1_700_000_000_000 + i,
    agent: { type: "AGENT", identifier: author },
    ...(model ? { model } : {}),
    signingKeyId: "0123456789abcdef",
    signature: "QUJDREVGR0g=",
    files: [{ path: file, mutationType: "MODIFIED", summary: `touch ${i}` }],
  });
}

/** Build a repo with N commits, each introducing one manifest (+ trailer for every 2nd). */
function makeRepo(n = 12, dir) {
  const repo = mkdtempSync(join(tmpdir(), "drift-bidx-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Test Dev"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "README.md"), "# t\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  for (let i = 1; i <= n; i++) {
    mkdirSync(join(repo, ".drift", "public", "intents"), { recursive: true });
    writeFileSync(join(repo, ".drift", "public", "intents", `${did(i)}.json`), manifest(i));
    git(repo, ["add", "-A"]);
    const trailer = i % 2 === 0 ? `\n\nDrift-Intent: ${did(i)}` : "";
    git(repo, ["commit", "-m", `commit ${i}${trailer}`]);
  }
  return repo;
}

/** Snapshot the fields that matter for equivalence. */
function shape(entries) {
  return entries.map((e) => ({
    id: e.id,
    ts: e.timestamp,
    gitSha: e.gitSha,
    assoc: e.association ? e.association.state : undefined,
    prompt: e.prompt,
    files: e.files.map((f) => f.path).sort(),
  }));
}

test("bounded log/context == full scan equivalence, store vs fresh-clone", () => {
  const repo = makeRepo(12);
  // A: fresh clone — no drift.db → bounded heap fallback.
  const fresh = Drift.fromCwd(repo);
  const freshLog = shape(fresh.log({ limit: 5 }));
  const freshContext = shape(fresh.context("src/app.ts", 5));
  const freshAll = shape(fresh.log({})); // full default limit 100
  fresh.close();

  // B: same tree + private store → index-backed path.
  Drift.init(repo, { author: "test" });
  const indexed = Drift.fromCwd(repo);
  const indexedLog = shape(indexed.log({ limit: 5 }));
  const indexedContext = shape(indexed.context("src/app.ts", 5));
  const indexedAll = shape(indexed.log({}));
  indexed.close();

  assert.equal(freshLog.length, 5);
  assert.deepEqual(indexedLog, freshLog, "log --limit 5 identical with index");
  assert.deepEqual(indexedContext, freshContext, "context identical with index");
  assert.deepEqual(indexedAll, freshAll, "default log identical with index");

  // Newest first, ids matching timestamps.
  assert.deepEqual(freshLog.map((e) => e.id), [did(12), did(11), did(10), did(9), did(8)]);

  // Trailer associations: even ids (trailer present) unique; odd ids missing.
  assert.equal(freshLog.find((e) => e.id === did(12)).assoc, "unique");
  assert.equal(freshLog.find((e) => e.id === did(11)).assoc, undefined);
});

test("index refreshes on new / changed / deleted manifest files", () => {
  const repo = makeRepo(8);
  Drift.init(repo, { author: "test" });
  const drift = Drift.fromCwd(repo);

  assert.deepEqual(drift.log({ limit: 3 }).map((e) => e.id), [did(8), did(7), did(6)]);

  // Change: rewrite manifest 6 with a newer timestamp → it becomes newest.
  const path6 = join(repo, ".drift", "public", "intents", `${did(6)}.json`);
  writeFileSync(
    path6,
    JSON.stringify({
      ...JSON.parse(readFileSync(path6, "utf8")),
      timestamp: 1_800_000_000_000,
      summary: "summary 6 changed",
    }),
  );
  let top = drift.log({ limit: 3 });
  assert.equal(top[0].id, did(6), "changed manifest re-parsed and re-ranked");
  assert.equal(top[0].summary, "summary 6 changed");

  // Delete: manifest 7 vanishes from results.
  rmSync(join(repo, ".drift", "public", "intents", `${did(7)}.json`));
  top = drift.log({ limit: 3 });
  assert.ok(!top.some((e) => e.id === did(7)), "deleted manifest dropped");

  // Add: a new manifest file (no git commit needed — working tree is the source).
  const newId = "did_ffffffffffffffffffffffffffffffff";
  writeFileSync(
    join(repo, ".drift", "public", "intents", `${newId}.json`),
    JSON.stringify({
      schemaVersion: 2,
      id: newId,
      summary: "newest manifest",
      timestamp: 1_900_000_000_000,
      agent: { type: "HUMAN", identifier: "bob" },
      signingKeyId: "0123456789abcdef",
      files: [{ path: "src/new.ts", mutationType: "ADDED", summary: "new" }],
    }),
  );
  top = drift.log({ limit: 3 });
  assert.equal(top[0].id, newId, "added manifest picked up without full re-parse");
  drift.close();
});

test("malformed and oversized manifests are never selected by log, surfaced by status", () => {
  const repo = makeRepo(6);
  Drift.init(repo, { author: "test" });
  const drift = Drift.fromCwd(repo);

  const badId = "did_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const dir = join(repo, ".drift", "public", "intents");
  writeFileSync(join(dir, `${badId}.json`), "{ not json");
  const bigId = "did_dddddddddddddddddddddddddddddddd";
  writeFileSync(
    join(dir, `${bigId}.json`),
    JSON.stringify({
      schemaVersion: 2,
      id: bigId,
      summary: "x".repeat(300 * 1024), // valid JSON but > 256 KiB cap
      timestamp: 1_999_000_000_000,
      signingKeyId: "0123456789abcdef",
    }),
  );

  const top = drift.log({ limit: 100 });
  assert.ok(!top.some((e) => e.id === badId), "malformed never selected");
  assert.ok(!top.some((e) => e.id === bigId), "oversized never selected");

  const status = Drift.status(repo);
  const diagIds = (status.malformedManifests ?? []).map((d) => d.id);
  assert.ok(diagIds.includes(badId), "status surfaces the malformed manifest");
  drift.close();
});

test("poisoned index cannot inject a malformed manifest into log; status re-verifies from files", () => {
  const repo = makeRepo(5);
  Drift.init(repo, { author: "test" });
  const drift = Drift.fromCwd(repo);
  const dir = join(repo, ".drift", "public", "intents");

  // Corrupt one manifest file AFTER the index has cached it, then make the
  // row's stat signature MATCH the corrupted file exactly — the refresh
  // trusts the stat, so the poisoned row survives as valid=1 while the file
  // on disk is malformed. This simulates a poisoned/attacker-written cache.
  const target = did(5);
  const file = join(dir, `${target}.json`);
  writeFileSync(file, "{ corrupt");
  const st = statSync(file);
  const db = new DatabaseSync(join(repo, ".drift", "drift.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.prepare(
    "UPDATE public_manifest_index SET valid = 1, mtime_ms = ?, size = ?, ctime_ms = ? WHERE id = ?",
  ).run(Math.trunc(st.mtimeMs), st.size, Math.trunc(st.ctimeMs), target);
  db.close();

  const top = drift.log({ limit: 100 });
  assert.ok(!top.some((e) => e.id === target), "poisoned valid flag cannot inject a corrupt file");

  // status re-reads every file and reports the truth regardless of the cache.
  const status = Drift.status(repo);
  const diagIds = (status.malformedManifests ?? []).map((d) => d.id);
  assert.ok(diagIds.includes(target), "status re-verifies the corrupted file from disk");
  drift.close();
});

test("index schema version bump drops and rebuilds the cache", () => {
  const repo = makeRepo(6);
  Drift.init(repo, { author: "test" });
  const drift = Drift.fromCwd(repo);
  const expected = drift.log({ limit: 100 }).map((e) => e.id);

  const db = new DatabaseSync(join(repo, ".drift", "drift.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.prepare("INSERT OR REPLACE INTO drift_meta (key, value) VALUES ('public_index_version', 'bogus-version')").run();
  // Also poison a row so a naive rebuild would be invisible to the test.
  db.prepare("UPDATE public_manifest_index SET valid = 0 WHERE id = ?").run(did(6));
  db.close();

  const rebuilt = drift.log({ limit: 100 }).map((e) => e.id);
  assert.deepEqual(rebuilt, expected, "version mismatch drops all rows and rebuilds");
  drift.close();
});

test("log --file prefix and author/model filters work through the index", () => {
  const repo = makeRepo(10);
  // Manifests 1..6 touch src/app.ts; 7..10 touch src/lib/util.ts.
  for (let i = 7; i <= 10; i++) {
    writeFileSync(
      join(repo, ".drift", "public", "intents", `${did(i)}.json`),
      manifest(i, { file: "src/lib/util.ts", author: i % 2 === 0 ? "bob" : "alice", model: "m1" }),
    );
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "files update"]);
  Drift.init(repo, { author: "test" });
  const drift = Drift.fromCwd(repo);

  const prefix = drift.log({ file: "src/lib", limit: 100 });
  assert.equal(prefix.length, 4);
  assert.ok(prefix.every((e) => e.files.some((f) => f.path.startsWith("src/lib"))));

  const author = drift.log({ author: "bob", limit: 100 });
  assert.ok(author.length >= 1);
  assert.ok(author.every((e) => e.authorId === "bob"));

  const model = drift.log({ model: "m1", limit: 100 });
  assert.ok(model.every((e) => e.model === "m1"));

  // context: exact file only.
  const ctx = drift.context("src/lib/util.ts", 10);
  assert.ok(ctx.length >= 1);
  assert.ok(ctx.every((e) => e.files.some((f) => f.path === "src/lib/util.ts")));
  drift.close();
});

test("index rows are per-working-tree and survive reopen (warm cache path)", () => {
  const repo = makeRepo(8);
  Drift.init(repo, { author: "test" });
  let drift = Drift.fromCwd(repo);
  const before = drift.log({ limit: 100 }).map((e) => e.id);
  drift.close();

  const db = new DatabaseSync(join(repo, ".drift", "drift.db"));
  const rows = db.prepare("SELECT COUNT(*) AS c FROM public_manifest_index").get();
  db.close();
  assert.equal(rows.c, 8, "index persisted 8 rows");

  drift = Drift.fromCwd(repo);
  assert.deepEqual(drift.log({ limit: 100 }).map((e) => e.id), before, "reopen serves identical results");
  drift.close();
});

test("git checkout rewrites stat data and the index refreshes (head switch)", () => {
  const repo = makeRepo(6);
  const head = git(repo, ["rev-parse", "HEAD"]);
  Drift.init(repo, { author: "test" });
  const drift = Drift.fromCwd(repo);
  assert.equal(drift.log({ limit: 100 }).length, 6);

  // Checkout a state with fewer manifests (HEAD~2), then back.
  git(repo, ["checkout", "-q", "HEAD~2"]);
  assert.equal(drift.log({ limit: 100 }).length, 4, "older tree: 4 manifests");

  git(repo, ["checkout", "-q", head]);
  assert.equal(drift.log({ limit: 100 }).length, 6, "back to head: 6 manifests again");
  drift.close();
});

test("git rebase/amend: associations are re-derived from Git, never cached", () => {
  const repo = makeRepo(6);
  Drift.init(repo, { author: "test" });
  const drift = Drift.fromCwd(repo);

  const entry = drift.log({ limit: 100 }).find((e) => e.id === did(6));
  assert.equal(entry.association.state, "unique");
  const oldSha = entry.gitSha;
  assert.ok(oldSha.length === 40, "introducing commit recorded");

  // Rewrite HEAD (amend) — the introducing commit SHA must change and the
  // trailer association must be re-derived from the NEW commit.
  git(repo, ["commit", "--amend", "-m", `commit 6 amended\n\nDrift-Intent: ${did(6)}`]);
  const newSha = git(repo, ["rev-parse", "HEAD"]);
  assert.notEqual(newSha, oldSha, "amend changed the commit");

  const after = drift.log({ limit: 100 }).find((e) => e.id === did(6));
  assert.equal(after.gitSha, newSha, "association follows the rewritten commit");
  assert.equal(after.association.state, "unique", "still a single introduction");
  assert.equal(after.association.commit, newSha);
  drift.close();
});

test("same-size + same-mtime tamper: displayed entries are re-read from disk, not the cache", () => {
  const repo = makeRepo(8);
  Drift.init(repo, { author: "test" });
  const drift = Drift.fromCwd(repo);
  const target = did(8);
  const file = join(repo, ".drift", "public", "intents", `${target}.json`);

  // Rewrite the file with a DIFFERENT summary of the SAME byte length, then
  // restore mtime. ctime is simulated by syncing the DB row's cached ctime to
  // the file (a ctime-preserving attacker). The refresh sees identical stats
  // and keeps the row — yet the selected entry MUST reflect the new content.
  const orig = JSON.parse(readFileSync(file, "utf8"));
  const newSummary = orig.summary.replace(/8$/, "!"); // same length, different content
  assert.equal(newSummary.length, orig.summary.length, "same byte length");
  writeFileSync(file, JSON.stringify({ ...orig, summary: newSummary }));
  const st = statSync(file);
  const now = new Date();
  const sameMtime = new Date(Math.trunc(st.mtimeMs));
  // utimesSync on Windows also bumps ctime — undo that in the cached row to
  // simulate an attacker who preserves both timestamps.
  const db = new DatabaseSync(join(repo, ".drift", "drift.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.prepare(
    "UPDATE public_manifest_index SET mtime_ms = ?, size = ?, ctime_ms = ? WHERE id = ?",
  ).run(Math.trunc(st.mtimeMs), st.size, Math.trunc(st.ctimeMs), target);
  db.close();

  const top = drift.log({ limit: 100 });
  const entry = top.find((e) => e.id === target);
  assert.equal(entry.summary, newSummary, "displayed entry re-read from the file");
  drift.close();
});

test("parallel Drift processes refresh the index concurrently without corruption", async () => {
  const repo = makeRepo(40);
  Drift.init(repo, { author: "test" });
  const cli = resolve(ROOT, "packages", "drift-cli", "dist", "cli.js");
  const run = (args) =>
    new Promise((res) => {
      const c = spawn(process.execPath, [cli, ...args], { cwd: repo, encoding: "utf8" });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", () => {});
      c.on("close", (code) => res({ code, out }));
    });

  const results = await Promise.all([
    run(["log", "--limit", "100"]),
    run(["log", "--limit", "100"]),
    run(["status"]),
    run(["log", "--limit", "100"]),
  ]);
  for (const r of results) {
    assert.equal(r.code, 0, `child exited 0 (got ${r.code})`);
  }
  const first = results[0].out;
  assert.equal(results[1].out, first, "concurrent logs agree");
  assert.equal(results[3].out, first, "three concurrent logs agree");

  // No corruption: a fresh process sees the full tree and a sane index.
  const drift = Drift.fromCwd(repo);
  assert.equal(drift.log({ limit: 100 }).length, 40);
  const db = new DatabaseSync(join(repo, ".drift", "drift.db"));
  const rows = db.prepare("SELECT COUNT(*) AS c FROM public_manifest_index").get();
  db.close();
  assert.equal(rows.c, 40, "index intact after parallel writers");
  drift.close();
});

test("crash mid-refresh: next run recovers and serves the full tree", async () => {
  const repo = mkdtempSync(join(tmpdir(), "drift-bidx-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Test Dev"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "README.md"), "# t\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  // A few thousand uncommitted working-tree manifests (legal input): the cold
  // index build is the slow window we crash inside.
  const dir = join(repo, ".drift", "public", "intents");
  mkdirSync(dir, { recursive: true });
  const N = 3000;
  for (let i = 1; i <= N; i++) {
    writeFileSync(join(dir, `${did(i)}.json`), manifest(i));
  }
  Drift.init(repo, { author: "test" });

  const coreDistUrl = pathToFileURL(coreDist).href;
  const child = spawn(
    process.execPath,
    [
      "-e",
      `(async () => {
         const { Drift } = await import(${JSON.stringify(coreDistUrl)});
         const d = Drift.fromCwd(${JSON.stringify(repo)});
         console.error("STARTED");
         const r = d.log({ limit: 100 });
         d.close();
         console.error("DONE " + r.length);
       })().catch((e) => { console.error("ERR " + e.message); process.exit(2); });`,
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let started = false;
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("child never started")), 30_000);
    child.stderr.on("data", (d) => {
      if (!started && d.toString().includes("STARTED")) {
        started = true;
        clearTimeout(timer);
        // Kill while the cold index build is in flight.
        setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          res();
        }, 150);
      }
    });
  });
  if (!started) throw new Error("child did not reach the refresh window");

  // Next run must recover (WAL rollback of the torn transaction). A hard
  // kill on Windows can briefly leave the DB handle locked — retry the open a
  // few times (transient), but REQUIRE a full, clean recovery: 100 entries,
  // no malformed files, the complete index rebuilt.
  let drift;
  let after;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      drift = Drift.fromCwd(repo);
      after = drift.log({ limit: 100 });
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  assert.equal(after.length, 100, "bounded log works after a killed refresh");
  const status = Drift.status(repo);
  assert.equal((status.malformedManifests ?? []).length, 0);
  const db = new DatabaseSync(join(repo, ".drift", "drift.db"));
  const rows = db.prepare("SELECT COUNT(*) AS c FROM public_manifest_index").get();
  db.close();
  assert.equal(rows.c, N, "index fully rebuilt after the crash");
  drift.close();
});
