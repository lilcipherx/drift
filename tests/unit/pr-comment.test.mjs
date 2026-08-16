import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSummary, upsertComment, SUMMARY_MARKER } from "../../scripts/pr-comment.mjs";

test("buildSummary: null for no intents", () => {
  assert.equal(buildSummary([]), null);
  assert.equal(buildSummary(undefined), null);
  assert.equal(buildSummary(null), null);
});

test("buildSummary: marker, heading, metadata, prompt and file table", () => {
  const body = buildSummary([
    {
      id: "did_abc123def456",
      authorId: "alice",
      authorType: "AGENT",
      model: "claude-3-5-sonnet",
      gitSha: "0123456789abcdef",
      prompt: "Add retry handling to the payment webhook",
      files: [{ path: "src/pay.ts", mutationType: "MODIFIED" }],
    },
  ]);
  assert.ok(body.startsWith(SUMMARY_MARKER), body);
  assert.ok(body.includes("## 🤖 Drift intent summary"), body);
  assert.ok(body.includes("1 intent on this PR"), body);
  assert.ok(body.includes("did_abc1"), body);
  assert.ok(body.includes("`alice` (AGENT)"), body);
  assert.ok(body.includes("claude-3-5-sonnet"), body);
  assert.ok(body.includes("`0123456`"), body);
  assert.ok(body.includes("Add retry handling to the payment webhook"), body);
  assert.ok(body.includes("| `src/pay.ts` | **MODIFIED** |"), body);
});

test("buildSummary: escapes pipes in paths and truncates long prompts", () => {
  const longPrompt = "x".repeat(500);
  const body = buildSummary([
    {
      id: "did_1",
      authorId: "bob",
      authorType: "HUMAN",
      prompt: longPrompt,
      files: [{ path: "weird|name.ts", mutationType: "ADDED" }],
    },
  ]);
  assert.ok(body.includes("weird\\|name.ts"), body);
  assert.ok(!body.includes(longPrompt), "long prompt must be truncated");
  assert.ok(body.includes("…"), body);
});

test("upsertComment: posts when no Drift comment exists, PATCHes in place when it does", async () => {
  const calls = [];
  // first run: no existing comment → POST
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    if (init.method === "POST") return { ok: true, json: async () => ({ id: 42 }) };
    return { ok: true, json: async () => [] };
  };
  const posted = await upsertComment({ token: "t", repo: "o/r", issueNumber: 3, body: "new", fetchImpl });
  assert.equal(posted.action, "commented");
  assert.ok(calls.some((c) => c.method === "POST"), "must POST when no marker comment exists");

  // second run: marker comment exists → PATCH, never POST
  const updated = await upsertComment({
    token: "t",
    repo: "o/r",
    issueNumber: 3,
    body: "new",
    fetchImpl: async (url, init = {}) => {
      if (init.method === "PATCH") return { ok: true, json: async () => ({ id: 7 }) };
      if (init.method === "POST") throw new Error("must not POST when a marker comment exists");
      return { ok: true, json: async () => [{ id: 7, body: `other\n${SUMMARY_MARKER}\nold` }] };
    },
  });
  assert.equal(updated.action, "updated");
  assert.equal(updated.id, 7);
});

test("upsertComment: non-ok responses throw clear errors", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403 });
  await assert.rejects(
    upsertComment({ token: "t", repo: "o/r", issueNumber: 3, body: "b", fetchImpl }),
    /list comments: HTTP 403/,
  );
});
