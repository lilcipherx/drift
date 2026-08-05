import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ParseError,
  computeDelta,
  detectLanguage,
  parseSymbols,
  textDelta,
} from "@drift/ast";

test("detectLanguage", () => {
  assert.equal(detectLanguage("src/auth.ts"), "typescript");
  assert.equal(detectLanguage("a.tsx"), "typescript");
  assert.equal(detectLanguage("app.py"), "python");
  assert.equal(detectLanguage("README.md"), null);
});

test("parses TS functions, classes, arrows", () => {
  const src = `
export function verifyToken(token: string): boolean {
  return token.length > 0;
}
export class Auth {
  login(user: string) {
    return user;
  }
}
export const helper = (x: number) => x * 2;
`;
  const symbols = parseSymbols(src, "typescript");
  const names = symbols.map((s) => s.name);
  assert.ok(names.includes("verifyToken"));
  assert.ok(names.includes("Auth"));
  assert.ok(names.includes("login"));
  assert.ok(names.includes("helper"));
  const vt = symbols.find((s) => s.name === "verifyToken");
  assert.ok(vt);
  assert.equal(vt.startLine, 2);
  assert.ok(vt.endLine > vt.startLine);
});

test("string literals do not create false declarations", () => {
  const src = `
const msg = "function fakeName() { return 1; }";
const real = () => 42;
`;
  const symbols = parseSymbols(src, "typescript");
  const names = symbols.map((s) => s.name);
  assert.ok(!names.includes("fakeName"));
  assert.ok(names.includes("real"));
});

test("parses Python", () => {
  const src = `
import os

def verify_token(token):
    return len(token) > 0

class AuthService:
    def login(self, user):
        return user
`;
  const symbols = parseSymbols(src, "python");
  const names = symbols.map((s) => s.name);
  assert.ok(names.includes("verify_token"));
  assert.ok(names.includes("AuthService"));
  assert.ok(names.includes("login"));
});

test("unbalanced braces throw ParseError", () => {
  assert.throws(() => parseSymbols("export const x = {", "typescript"), ParseError);
  assert.throws(() => parseSymbols("const y = }", "typescript"), ParseError);
});

test("delta: added function", () => {
  const pre = parseSymbols("export const a = () => 1;\n", "typescript");
  const post = parseSymbols("export const a = () => 1;\nexport const b = () => 2;\n", "typescript");
  const d = computeDelta("x.ts", pre, post);
  assert.ok(d.changes.some((c) => c.type === "ADDED" && c.summary.includes("b")));
});

test("delta: modified function", () => {
  const pre = parseSymbols("export function f() { return 1; }\n", "typescript");
  const post = parseSymbols("export function f() { return 2; }\n", "typescript");
  const d = computeDelta("x.ts", pre, post);
  assert.ok(d.changes.some((c) => c.type === "MODIFIED" && c.summary.includes("f")));
});

test("delta: renamed function detected by body hash", () => {
  const pre = parseSymbols("export function oldName() { return 42; }\n", "typescript");
  const post = parseSymbols("export function newName() { return 42; }\n", "typescript");
  const d = computeDelta("x.ts", pre, post);
  assert.ok(d.changes.some((c) => c.type === "RENAMED"));
});

test("delta: deleted function", () => {
  const pre = parseSymbols("export function a() {}\nexport function b() {}\n", "typescript");
  const post = parseSymbols("export function a() {}\n", "typescript");
  const d = computeDelta("x.ts", pre, post);
  assert.ok(d.changes.some((c) => c.type === "DELETED" && c.summary.includes("b")));
});

test("delta: new file is ADDED, deleted file is DELETED", () => {
  const src = "export const x = () => 1;\n";
  const d1 = computeDelta("new.ts", null, parseSymbols(src, "typescript"));
  assert.equal(d1.changes[0].type, "ADDED");
  const d2 = computeDelta("gone.ts", parseSymbols(src, "typescript"), null);
  assert.equal(d2.changes[0].type, "DELETED");
});

test("textDelta for unsupported files", () => {
  const d = textDelta("data.json", "{}", '{"a":1}');
  assert.equal(d.changes[0].type, "MODIFIED");
  const added = textDelta("data.json", null, "{}");
  assert.equal(added.changes[0].type, "ADDED");
});
