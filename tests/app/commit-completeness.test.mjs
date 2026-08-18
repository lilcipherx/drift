/**
 * PR commit enumeration completeness (PR #7 final-completeness correction 4):
 * the Pull Request Commits REST endpoint caps at 250 commits, so the App must
 * NEVER issue a trust conclusion from a truncated list. These tests drive the
 * REAL `GitHubAppClient.getPullCommits` against a fake fetch and assert the
 * exact fail-closed conditions: over-endpoint-limit, count mismatch, duplicate
 * SHA, invalid SHA, interrupted pagination — and the happy path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appDist = join(here, "..", "..", "packages", "drift-app", "dist");
const { GitHubAppClient } = await import(pathToFileURL(join(appDist, "github.js")).href);

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });

function makeClient(routes) {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const route = routes.find((r) => {
      // handler routes paginate the commits path; plain routes are exact.
      if (r.handler) {
        if (!u.pathname.startsWith(r.path)) return false;
      } else if (u.pathname !== r.path) {
        return false;
      }
      if (r.query && !u.search.includes(r.query)) return false;
      return true;
    });
    if (!route) {
      return new Response(JSON.stringify({ message: `no mock route ${u.pathname}${u.search}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    // handler-based routes decide the response from the request query (page).
    const answered = route.handler ? route.handler({ searchParams: u.searchParams }) : route;
    const headers = { "content-type": "application/json" };
    if (answered.link) headers.link = answered.link;
    return new Response(JSON.stringify(answered.body), { status: answered.status ?? 200, headers });
  };
  return new GitHubAppClient({
    appId: "12345",
    privateKeyPem: rsa.privateKey.export({ type: "pkcs1", format: "pem" }),
    fetchImpl,
  });
}

/**
 * A realistic paginated `/pulls/{n}/commits` mock: slices the entries into
 * `per_page` chunks and emits Link rel="next" headers exactly like GitHub.
 * `stallAtPage` (when set) makes the listing STOP after that page (no next
 * Link) to simulate an interrupted API response.
 */
function paginatedCommits(entries, { perPage = 100, stallAtPage } = {}) {
  return {
    path: "/repos/o/r/pulls/7/commits",
    handler({ searchParams }) {
      const page = Number(searchParams.get("page") ?? "1");
      if (stallAtPage !== undefined && page > stallAtPage) {
        return { body: [] }; // API stops producing pages (interrupted)
      }
      const start = (page - 1) * perPage;
      const slice = entries.slice(start, start + perPage);
      // With a stall, the stall page still advertises a next page so the
      // client tries to continue and observes the interruption.
      const hasNext =
        stallAtPage === undefined ? start + perPage < entries.length : page <= stallAtPage;
      const nextUrl = `/repos/o/r/pulls/7/commits?per_page=${perPage}&page=${page + 1}`;
      return { body: slice, ...(hasNext ? { link: `<https://api.github.com${nextUrl}>; rel="next"` } : {}) };
    },
  };
}

const prRoute = (commits, changedFiles = 0) => ({
  path: "/repos/o/r/pulls/7",
  body: {
    head: { sha: sha(999) },
    base: { sha: sha(1) },
    commits,
    changed_files: changedFiles,
    title: "t",
  },
});

const tokenRoute = {
  path: "/app/installations/1/access_tokens",
  body: { token: "tkn", expires_at: new Date(Date.now() + 3600_000).toISOString() },
};

function withCommon(routes) {
  return [tokenRoute, ...routes];
}

function sha(n) {
  return n.toString(16).padStart(40, "0");
}

function commitEntry(n, overrides = {}) {
  return { sha: sha(n), commit: { message: `commit ${n}` }, ...overrides };
}

test("commit completeness: complete when the returned unique count equals the PR metadata count", async () => {
  const entries = [commitEntry(2), commitEntry(3), commitEntry(4)];
  const client = makeClient(withCommon([prRoute(3), paginatedCommits(entries)]));
  client.setInstallation(1);
  const c = await client.getPullCommits("o", "r", 7);
  assert.equal(c.complete, true);
  assert.equal(c.commits.length, 3);
  assert.equal(c.reason, undefined);
});

test("commit completeness: >250 expected commits is over-endpoint-limit even when the endpoint returns its cap", async () => {
  const entries = Array.from({ length: 250 }, (_, i) => commitEntry(2 + i));
  const client = makeClient(withCommon([prRoute(251), paginatedCommits(entries)]));
  client.setInstallation(1);
  const c = await client.getPullCommits("o", "r", 7);
  assert.equal(c.complete, false, "a 251-commit PR can never be fully enumerated");
  assert.equal(c.reason, "over-endpoint-limit");
  assert.equal(c.expectedCount, 251);
});

test("commit completeness: expected 20 / returned 19 is count-mismatch", async () => {
  const entries = Array.from({ length: 19 }, (_, i) => commitEntry(2 + i));
  const client = makeClient(withCommon([prRoute(20), paginatedCommits(entries)]));
  client.setInstallation(1);
  const c = await client.getPullCommits("o", "r", 7);
  assert.equal(c.complete, false);
  assert.equal(c.reason, "count-mismatch");
});

test("commit completeness: expected 20 / returned 21 is count-mismatch", async () => {
  const entries = Array.from({ length: 21 }, (_, i) => commitEntry(2 + i));
  const client = makeClient(withCommon([prRoute(20), paginatedCommits(entries)]));
  client.setInstallation(1);
  const c = await client.getPullCommits("o", "r", 7);
  assert.equal(c.complete, false);
  assert.equal(c.reason, "count-mismatch");
});

test("commit completeness: duplicate SHA entries are duplicate-sha", async () => {
  const entries = [commitEntry(2), commitEntry(2), commitEntry(3)];
  const client = makeClient(withCommon([prRoute(3), paginatedCommits(entries)]));
  client.setInstallation(1);
  const c = await client.getPullCommits("o", "r", 7);
  assert.equal(c.complete, false);
  assert.equal(c.reason, "duplicate-sha");
});

test("commit completeness: malformed SHA entries are invalid-sha", async () => {
  const entries = [{ sha: "short", commit: { message: "bad sha" } }, commitEntry(3)];
  const client = makeClient(withCommon([prRoute(2), paginatedCommits(entries)]));
  client.setInstallation(1);
  const c = await client.getPullCommits("o", "r", 7);
  assert.equal(c.complete, false);
  assert.equal(c.reason, "invalid-sha");
});

test("commit completeness: pagination interrupted mid-way is pagination-interrupted", async () => {
  const entries = Array.from({ length: 150 }, (_, i) => commitEntry(2 + i));
  const client = makeClient(
    withCommon([prRoute(150), paginatedCommits(entries, { stallAtPage: 1 })]),
  );
  client.setInstallation(1);
  const c = await client.getPullCommits("o", "r", 7);
  assert.equal(c.complete, false, "a listing that stops early is never complete");
  assert.equal(c.reason, "pagination-interrupted");
});

test("commit completeness: 0 commits and 1 commit are ordinary", async () => {
  const client0 = makeClient(withCommon([prRoute(0), paginatedCommits([])]));
  client0.setInstallation(1);
  const c0 = await client0.getPullCommits("o", "r", 7);
  assert.equal(c0.complete, true);
  assert.equal(c0.commits.length, 0);

  const client1 = makeClient(withCommon([prRoute(1), paginatedCommits([commitEntry(2)])]));
  client1.setInstallation(1);
  const c1 = await client1.getPullCommits("o", "r", 7);
  assert.equal(c1.complete, true);
  assert.equal(c1.commits.length, 1);
});

test("commit completeness: 249 and 250 commits are complete when counts match", async () => {
  for (const n of [249, 250]) {
    const entries = Array.from({ length: n }, (_, i) => commitEntry(2 + i));
    const client = makeClient(withCommon([prRoute(n), paginatedCommits(entries)]));
    client.setInstallation(1);
    const c = await client.getPullCommits("o", "r", 7);
    assert.equal(c.complete, true, `${n} commits with a matching count must be complete`);
    assert.equal(c.reason, undefined);
  }
});
