// Behavioral verification for the webhook-server close() sweep/grace fix
// (commit c6564cc). Drives the REAL built code (packages/drift-app/dist) —
// no test doubles for the server itself; only the external GitHub API is
// mocked, as in the live test suites. Traces the full lifecycle:
//   C1 happy-path webhook  ->  C2 in-flight webhook + close() during handler
//   C3 idempotent double close()  ->  port release  ->  no process errors
import { createServer } from "node:http";
import { connect } from "node:net";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const DIST = join(process.cwd(), "packages/drift-app/dist");
const mod = (name) => import(pathToFileURL(join(DIST, name)).href);

const SECRET = "behavior-verify-secret";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ID = "did_cccccccccccccccccccccccccccccccc";
const HEAD = "3".repeat(40);
const OBJECT_PATH = ".drift/objects/cc/cccccccccccccccccccccccccccccccccccccccc.json";

let commitsDelay = 0; // ms; set to 800 to hold a webhook mid-flight
const comments = [];
const state = { posted: 0, updated: 0, checkRuns: 0 };

const processErrors = [];
process.on("uncaughtException", (e) => processErrors.push(e));
process.on("unhandledRejection", (e) => processErrors.push(e));

const intentObj = {
  id: ID,
  parentId: null,
  author: { type: "AGENT", identifier: "claude", model: "claude-3-5-sonnet" },
  prompt: "behavior-verify intent prompt",
  astDelta: [{ filePath: "src/auth.ts", type: "ADDED", summary: "add login handler" }],
  agentState: null,
  verifyCmd: null,
  timestamp: 123,
  gitCommitSha: "",
  signature: "MOCK-SIG",
};
const objects = { [OBJECT_PATH]: intentObj };

console.log("STEP 1: creating mock GitHub");
const mock = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const path = u.pathname;
  console.log(`  [mock] ${req.method} ${path}`);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const json = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "POST" && path.endsWith("/access_tokens")) {
      return json(201, { token: "mock-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (req.method === "GET" && /\/pulls\/\d+$/.test(path)) {
      return json(200, { head: { sha: HEAD }, title: "feat: behavior verify" });
    }
    if (req.method === "GET" && path.match(/\/pulls\/\d+\/commits$/)) {
      if (commitsDelay > 0) await sleep(commitsDelay); // hold the handler mid-flight
      return json(200, [{ sha: "e".repeat(40), commit: { message: `chore: x\n\nDrift-Intent: ${ID}` } }]);
    }
    if (req.method === "GET" && path.includes("/git/trees/")) {
      return json(200, { tree: [{ path: OBJECT_PATH, type: "blob" }] });
    }
    if (req.method === "GET" && path.includes("/contents/")) {
      const obj = objects[decodeURIComponent(path.split("/contents/")[1].split("?")[0])];
      if (!obj) return json(404, { message: "Not Found" });
      return json(200, { content: Buffer.from(JSON.stringify(obj), "utf8").toString("base64"), encoding: "base64" });
    }
    const commentsMatch = path.match(/\/issues\/(\d+)\/comments$/);
    if (commentsMatch) {
      if (req.method === "GET") return json(200, comments.map(({ id, body: b }) => ({ id, body: b })));
      if (req.method === "POST") {
        const { body: text } = JSON.parse(body || "{}");
        state.posted++;
        comments.push({ id: 8000 + state.posted, body: text });
        return json(201, { id: 8000 + state.posted, body: text });
      }
    }
    const commentIdMatch = path.match(/\/issues\/comments\/(\d+)$/);
    if (commentIdMatch && req.method === "PATCH") {
      const c = comments.find((x) => x.id === Number(commentIdMatch[1]));
      if (!c) return json(404, { message: "Not Found" });
      const { body: text } = JSON.parse(body || "{}");
      state.updated++;
      c.body = text;
      return json(200, { id: c.id, body: text });
    }
    if (req.method === "POST" && path.includes("/check-runs")) {
      state.checkRuns++;
      return json(201, { id: state.checkRuns });
    }
    json(404, { message: `mock: no route ${req.method} ${path}` });
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const mockPort = mock.address().port;

console.log("STEP 2: building real GitHubAppClient + webhook server");
const { createWebhookServer } = await mod("server.js");
const { GitHubAppClient } = await mod("github.js");
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const github = new GitHubAppClient({
  appId: "12345",
  privateKeyPem: key.privateKey.export({ type: "pkcs1", format: "pem" }),
  baseUrl: `http://127.0.0.1:${mockPort}`,
});

const payload = () =>
  JSON.stringify({
    action: "opened",
    installation: { id: 42 },
    repository: { name: "demo", owner: { login: "lilcipherx" } },
    pull_request: { number: 78, title: "feat: behavior verify", head: { sha: HEAD } },
  });
const sendWebhook = (port) => {
  const raw = payload();
  return fetch(`http://127.0.0.1:${port}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`,
    },
    body: raw,
  }).then((r) => r.json());
};
const connectRefused = (port) =>
  new Promise((res) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => res(false));
    s.once("error", (e) => res(e.code === "ECONNREFUSED"));
  });

// ---------------------------------------------------------------- check 1
console.log("STEP 3: boot webhook server");
const srv = await createWebhookServer({
  github,
  webhookSecret: SECRET,
  port: 0,
  log: (line) => console.log(`  [app] ${line}`),
});
console.log("STEP 4: C1 happy-path webhook");
{
  const r = await sendWebhook(srv.port);
  if (r.action !== "commented") throw new Error(`C1: expected commented, got ${r.action}`);
  if (r.intentsFound !== 1) throw new Error(`C1: expected 1 intent, got ${r.intentsFound}`);
  if (state.posted !== 1) throw new Error(`C1: comment not posted (posted=${state.posted})`);
  if (state.checkRuns !== 1) throw new Error("C1: check run not created");
  if (!comments[0].body.includes("behavior-verify intent prompt")) throw new Error("C1: comment body missing prompt");
  if (!comments[0].body.includes("<!-- drift:summary -->")) throw new Error("C1: comment body missing marker");
  console.log("C1 OK: comment landed with prompt + marker, check run created\n");
}

// ---------------------------------------------------------------- check 2
console.log("STEP 5: C2 in-flight + close() during handler");
{
  commitsDelay = 800;
  const posting = sendWebhook(srv.port);
  await sleep(150); // handler mid-flight in the slow commits call
  const t0 = Date.now();
  const closing = srv.close();
  const r = await Promise.race([
    posting,
    sleep(8_000).then(() => {
      throw new Error("C2: webhook response never arrived (posting hung)");
    }),
  ]);
  const deliveredAt = Date.now() - t0;
  await Promise.race([closing, sleep(1_500)]);
  const closeElapsed = Date.now() - t0;

  if (r.action !== "updated") {
    throw new Error(`C2: in-flight request was cut or not idempotent: ${JSON.stringify(r).slice(0, 160)}`);
  }
  if (state.posted !== 1) throw new Error(`C2: comment duplicated (posted=${state.posted}) — idempotency broken`);
  if (state.updated !== 1) throw new Error(`C2: comment not updated via marker (updated=${state.updated})`);
  console.log(`C2: response delivered after ${deliveredAt}ms; close resolved at ${closeElapsed}ms (force grace is 5000ms)`);
  if (closeElapsed >= 4_000) {
    throw new Error(`C2: close waited out the force grace (${closeElapsed}ms) — sweep did not release the socket`);
  }
  const freed = await connectRefused(srv.port);
  if (!freed) throw new Error("C2: port not released after close()");
  console.log("C2 OK: in-flight spared (response delivered, comment updated once), close resolved promptly, port released\n");
}

// ---------------------------------------------------------------- check 3
console.log("STEP 6: C3 idempotent double close");
{
  const srv2 = await createWebhookServer({ github, webhookSecret: SECRET, port: 0 });
  const t0 = Date.now();
  const [a, b] = [srv2.close(), srv2.close()];
  await Promise.all([a, b]);
  const elapsed = Date.now() - t0;
  if (elapsed > 1_000) throw new Error(`C3: double close took ${elapsed}ms — hang`);
  const freed = await connectRefused(srv2.port);
  if (!freed) throw new Error("C3: srv2 port not released");
  console.log(`C3 OK: double close() resolved once in ${elapsed}ms, port released\n`);
}

// ---------------------------------------------------------------- check 4
console.log("STEP 7: final checks");
if (processErrors.length > 0) {
  throw new Error(`C4: server process errors: ${processErrors.map(String).join(" | ")}`);
}
console.log("C4 OK: no uncaughtException / unhandledRejection");

await new Promise((r) => mock.close(r));
console.log("\nALL BEHAVIOR CHECKS PASSED");
process.exit(0);
