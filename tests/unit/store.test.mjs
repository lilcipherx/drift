/**
 * IntentStore unit tests: limit validation in listIntents / contextForFile.
 * Non-finite or negative limits must be clamped instead of being interpolated
 * into SQL (which would raise "no such column: Infinity").
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntentStore } from "@drift/core";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "drift-store-"));
  mkdirSync(join(dir, ".drift"), { recursive: true });
  const store = IntentStore.open(join(dir, ".drift", "drift.db"));
  return { dir, store };
}

function record(id, gitSha) {
  return {
    id,
    parentId: null,
    gitCommitSha: gitSha,
    author: { type: "HUMAN", identifier: "tester" },
    prompt: `prompt ${id}`,
    astDelta: [{ filePath: "a.ts", type: "ADDED", nodeIds: [], summary: "" }],
    timestamp: Number(id.replace("did_", "")),
    objectPath: ".drift/objects/00/aa.json",
    signature: "",
  };
}

test("listIntents: Infinity/NaN limits fall back instead of crashing", () => {
  const { store } = makeStore();
  try {
    store.insertIntent(record("did_00000000000000000000000000000001", "a".repeat(40)));
    store.insertIntent(record("did_00000000000000000000000000000002", "b".repeat(40)));
    store.insertIntent(record("did_00000000000000000000000000000003", "c".repeat(40)));
    // Would previously interpolate "LIMIT Infinity"/"LIMIT NaN" into SQL.
    assert.equal(store.listIntents({ limit: Infinity }).length, 3);
    assert.equal(store.listIntents({ limit: NaN }).length, 3);
  } finally {
    store.close();
  }
});

test("listIntents: negative and fractional limits are clamped to >= 1", () => {
  const { store } = makeStore();
  try {
    store.insertIntent(record("did_00000000000000000000000000000011", "d".repeat(40)));
    store.insertIntent(record("did_00000000000000000000000000000012", "e".repeat(40)));
    assert.equal(store.listIntents({ limit: -5 }).length, 1);
    assert.equal(store.listIntents({ limit: 1.7 }).length, 1);
    assert.equal(store.listIntents({ limit: 0 }).length, 1);
  } finally {
    store.close();
  }
});

test("contextForFile: non-finite limit does not crash", () => {
  const { store } = makeStore();
  try {
    store.insertIntent(record("did_00000000000000000000000000000021", "f".repeat(40)));
    store.insertIntent(record("did_00000000000000000000000000000022", "g".repeat(40)));
    assert.equal(store.contextForFile("a.ts", Infinity).length, 2);
    assert.equal(store.contextForFile("a.ts", NaN).length, 2);
    assert.equal(store.contextForFile("a.ts", -3).length, 1);
  } finally {
    store.close();
  }
});
