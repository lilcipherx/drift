/**
 * Live E2E — graceful shutdown must never hang.
 *
 * Bare `server.close()` waits for EVERY open connection; a client holding an
 * idle keep-alive socket (or a mid-request client) would block shutdown
 * forever. Root cause of a hang observed while verifying SIGTERM shutdown:
 * nothing releases idle connections. Fix: closeIdleConnections() immediately
 * + a bounded force-close of stragglers after a grace period.
 *
 * The race (3 s vs the 5 s force-close grace) keeps the failing state
 * deterministic: without the fix this test fails (close never resolves), with
 * the fix it resolves in milliseconds.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { connect } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appDist = join(here, "..", "..", "packages", "drift-app", "dist");
const mod = (name) => import(pathToFileURL(join(appDist, name)).href);

const SECRET = "shutdown-test-secret";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("close() completes despite an idle keep-alive connection (no hang)", async () => {
  const { createWebhookServer } = await mod("server.js");
  const { GitHubAppClient } = await mod("github.js");
  // The GitHub client is never called in this test — the bare mock exists so
  // the server can be constructed (WebhookDeps requires it).
  const mock = createServer(() => {});
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const github = new GitHubAppClient({
    appId: "1",
    privateKeyPem: key.privateKey.export({ type: "pkcs1", format: "pem" }),
    baseUrl: `http://127.0.0.1:${mock.address().port}`,
  });

  const srv = await createWebhookServer({ github, webhookSecret: SECRET, port: 0 });

  // Hold an idle keep-alive socket open — no HTTP request is ever sent.
  const sock = connect(srv.port, "127.0.0.1");
  await new Promise((res, rej) => {
    sock.once("connect", res);
    sock.once("error", rej);
  });

  let closed = false;
  const closing = srv.close().then(() => {
    closed = true;
  });
  try {
    // Bounded: 2 s < the 5 s force-close grace, so ONLY closeIdleConnections
    // (the real fix) can resolve close() while the socket is still open. On
    // unfixed code this races to the timeout and the assert fails — red.
    await Promise.race([closing, sleep(2_000)]);
    assert.equal(closed, true, "close() must not hang on an idle keep-alive socket");
  } finally {
    sock.destroy();
    await closing.catch(() => {});
    await new Promise((r) => mock.close(r));
  }
});

test("after close(), the server stops accepting new connections", async () => {
  const { createWebhookServer } = await mod("server.js");
  const { GitHubAppClient } = await mod("github.js");
  const mock = createServer(() => {});
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const github = new GitHubAppClient({
    appId: "1",
    privateKeyPem: key.privateKey.export({ type: "pkcs1", format: "pem" }),
    baseUrl: `http://127.0.0.1:${mock.address().port}`,
  });

  const srv = await createWebhookServer({ github, webhookSecret: SECRET, port: 0 });
  await srv.close();
  await new Promise((r) => mock.close(r));

  // connect() must fail now — the listener is gone
  await assert.rejects(
    () =>
      new Promise((res, rej) => {
        const s = connect(srv.port, "127.0.0.1", res);
        s.once("error", rej);
      }),
    "connection to a closed server must be refused",
  );
});
