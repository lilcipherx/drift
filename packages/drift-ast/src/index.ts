/**
 * @drift/ast — semantic parsing and AST delta computation.
 *
 * The parser is intentionally dependency-free: it extracts named symbols
 * (functions, classes, methods, arrow-function constants) from source code,
 * producing a stable "semantic signature" for a file. Deltas between two
 * states of a file are computed at symbol granularity, so a rename is a
 * RENAMED mutation rather than delete+add, and a function that moved is
 * MOVED rather than modified.
 *
 * The parser interface (`parseSymbols`) is the plugin point where a full
 * tree-sitter implementation can be dropped in later (ADR-002).
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

export type MutationType =
  | "ADDED"
  | "MODIFIED"
  | "DELETED"
  | "MOVED"
  | "RENAMED";

export type SymbolKind = "function" | "method" | "class" | "arrow" | "default";

export interface SymbolInfo {
  /** Unique semantic id for the node, e.g. `src/auth.ts::function::verifyToken`. */
  id: string;
  name: string;
  kind: SymbolKind;
  /** 1-based start line */
  startLine: number;
  /** 1-based inclusive end line */
  endLine: number;
  /** SHA-256 hex of the trimmed source span (used for rename/move detection) */
  bodyHash: string;
}

export interface ASTDelta {
  filePath: string;
  type: MutationType;
  nodeIds: string[];
  summary: string;
}

export interface FileDelta {
  filePath: string;
  pre: SymbolInfo[];
  post: SymbolInfo[];
  changes: ASTDelta[];
}

export type SupportedLanguage = "typescript" | "python";

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** Map a file path to a supported language, or null when unsupported. */
export function detectLanguage(filePath: string): SupportedLanguage | null {
  const lower = filePath.toLowerCase();
  const basename = lower.split(/[\\/]/).pop() ?? "";
  if (basename.startsWith(".")) return null; // dotfiles
  for (const ext of [".tsx", ".mts", ".cts", ".ts", ".jsx", ".mjs", ".cjs", ".js"]) {
    if (basename.endsWith(ext)) return "typescript";
  }
  if (basename.endsWith(".py")) return "python";
  return null;
}

/** Rough binary sniff: NUL byte in the first 8 KiB. */
export function isBinary(content: Buffer): boolean {
  const sample = content.subarray(0, 8192);
  return sample.includes(0);
}

/** Characters that put the lexer in an expression position (a `/` starts a regex literal). */
const REGEX_START_PREV = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";",
  "+", "-", "*", "%", "^", "~", "<", ">",
]);

/** Keywords after which a `/` starts a regex literal (e.g. `return /re/`). */
const REGEX_START_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "case", "delete",
  "void", "throw", "new", "do", "else", "yield", "await", "default",
]);

/**
 * True when the `/` at `i` starts a regex literal rather than a division.
 * Uses the standard lexer heuristic: an expression-position slash (previous
 * non-space char is an operator/punct or a keyword like `return`) starts a
 * regex; a slash after an identifier/`)`/`]` is division.
 */
function isRegexStart(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j]!)) j--;
  if (j < 0) return true; // start of input
  const prev = src[j]!;
  if (REGEX_START_PREV.has(prev)) return true;
  if (/[A-Za-z0-9_$]/.test(prev)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k]!)) k--;
    const word = src.slice(k + 1, j + 1);
    return REGEX_START_KEYWORDS.has(word);
  }
  return false;
}

/**
 * Mask a regex literal `[...]`-aware (escapes and char classes keep `/`
 * from closing it). Returns the index just past the literal, or -1 when the
 * slash turns out not to be a regex (no closing `/` before a newline).
 */
function maskRegexLiteral(out: string[], src: string, i: number, n: number): number {
  let inClass = false;
  let k = i + 1;
  while (k < n) {
    const ch = src[k]!;
    if (ch === "\\") {
      k += 2;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      k++;
      continue;
    }
    if (ch === "]") {
      inClass = false;
      k++;
      continue;
    }
    if (ch === "\n") break; // unterminated — not a regex literal
    if (ch === "/" && !inClass) {
      for (let m = i; m <= k; m++) {
        if (src[m] !== "\n") out[m] = " ";
      }
      return k + 1;
    }
    k++;
  }
  return -1;
}

/**
 * Replace strings, comments and regex literals with spaces (newlines
 * preserved) so that declaration regexes and brace matching never trip over
 * literals.
 */
function maskCode(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  const maskTo = (end: number) => {
    for (let k = i; k <= end && k < n; k++) {
      if (src[k] !== "\n") out[k] = " ";
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j + 1 < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      maskTo(Math.min(j + 1, n - 1));
      i = Math.min(j + 2, n);
      continue;
    }
    if (c === "/" && src[i + 1] !== "/" && src[i + 1] !== "*") {
      if (isRegexStart(src, i)) {
        const after = maskRegexLiteral(out, src, i, n);
        if (after > i) {
          i = after;
          continue;
        }
      }
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        j++;
      }
      maskTo(j);
      i = j + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        const ch = src[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "$" && src[j + 1] === "{") {
          depth++;
          j += 2;
          continue;
        }
        if (ch === "}") {
          depth = Math.max(0, depth - 1);
          j++;
          continue;
        }
        if (ch === "`" && depth === 0) break;
        j++;
      }
      maskTo(j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

function hashBody(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex");
}

function lineAt(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}

/** Find the end index of the `{...}` block beginning at or after `start`. */
function blockEnd(masked: string, start: number, srcLen: number): number | null {
  const open = masked.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return srcLen - 1;
}

interface RawDecl {
  name: string;
  kind: SymbolKind;
  start: number;
  /** Index just past the symbol name — body hashes start here so renames are detectable. */
  bodyStart: number;
  /** Closing brace index for brace languages, or null. */
  blockEndIdx: number | null;
  /** Index of the end of the declaration's first line (for brace-less forms). */
  lineEnd: number;
}

function lineEndIndex(masked: string, start: number): number {
  const nl = masked.indexOf("\n", start);
  return nl === -1 ? masked.length - 1 : nl;
}

function extractDeclarations(masked: string, srcLen: number, braceLang: boolean): RawDecl[] {
  const decls: RawDecl[] = [];
  const push = (
    m: RegExpExecArray,
    kind: SymbolKind,
  ) => {
    const rawName = m[1] ?? "";
    const name = rawName.trim() || "default";
    const nameInMatch = m[0].indexOf(rawName);
    decls.push({
      name: name === "default" ? "default" : name,
      kind,
      start: m.index,
      bodyStart: nameInMatch >= 0 ? m.index + nameInMatch + rawName.length : m.index,
      blockEndIdx: braceLang ? blockEnd(masked, m.index, srcLen) : null,
      lineEnd: lineEndIndex(masked, m.index),
    });
  };

  // function name( ... ) { ... }  (with optional async, generator, export)
  const fnRe =
    /\b(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*|\()/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(masked)) !== null) {
    if (m[0].endsWith("(")) continue; // anonymous `function(`
    push(m, "function");
  }

  // class Name { ... }
  const clsRe = /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
  while ((m = clsRe.exec(masked)) !== null) {
    push(m, "class");
  }

  // const name = (...) => { ... }  /  const name = async (...) => ...
  const arrowRe =
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = arrowRe.exec(masked)) !== null) {
    push(m, "arrow");
  }

  // methods: name( ... ) { ... } at a line start (inside classes / objects)
  const CONTROL_KEYWORDS = new Set([
    "if", "for", "while", "switch", "catch", "with", "do", "return",
  ]);
  const methodRe = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
  while ((m = methodRe.exec(masked)) !== null) {
    if (CONTROL_KEYWORDS.has(m[1]!)) continue; // control-flow, not a method
    push(m, "method");
  }

  // Python def / class
  if (!braceLang) {
    const pyDefRe = /^(?:\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm;
    while ((m = pyDefRe.exec(masked)) !== null) {
      push(m, "method");
    }
    const pyClsRe = /^(\s*)class\s+([A-Za-z_]\w*)/gm;
    while ((m = pyClsRe.exec(masked)) !== null) {
      push(m, "class");
    }
  }

  decls.sort((a, b) => a.start - b.start);
  // Drop duplicate (kind, name) pairs, keeping the outermost (first) one.
  const seen = new Map<string, RawDecl>();
  for (const d of decls) {
    const key = `${d.kind}::${d.name}`;
    if (!seen.has(key)) {
      seen.set(key, d);
    }
  }
  return [...seen.values()];
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

/**
 * Parse a source file into named symbols.
 * Throws {@link ParseError} when the source is syntactically broken
 * (e.g. unbalanced braces) so callers can reject the commit (exit code 2).
 */
export function parseSymbols(
  source: string,
  language: SupportedLanguage,
): SymbolInfo[] {
  const masked = maskCode(source);
  // Syntax sanity: braces must balance (strings/comments are masked out).
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0) {
        throw new ParseError("Unexpected `}` — unbalanced braces");
      }
    }
  }
  if (depth !== 0) {
    throw new ParseError(`Unbalanced braces (${depth} unclosed)`);
  }

  const braceLang = language !== "python";
  const decls = extractDeclarations(masked, source.length, braceLang);

  const symbols: SymbolInfo[] = [];
  for (let i = 0; i < decls.length; i++) {
    const d = decls[i]!;
    let end: number;
    if (d.blockEndIdx !== null) {
      end = d.blockEndIdx;
    } else if (language === "python") {
      // Python bodies run until the next declaration (or EOF).
      end = (decls[i + 1]?.start ?? source.length) - 1;
    } else {
      end = Math.max(d.lineEnd, d.start);
    }
    const body =
      end >= d.bodyStart ? source.slice(d.bodyStart, end + 1) : "";
    symbols.push({
      id: `::${d.kind}::${d.name}`,
      name: d.name,
      kind: d.kind,
      startLine: lineAt(source, d.start),
      endLine: lineAt(source, end),
      bodyHash: hashBody(body),
    });
  }
  return symbols;
}

export function parseFile(
  filePath: string,
  source: string,
): { symbols: SymbolInfo[]; language: SupportedLanguage } {
  const language = detectLanguage(filePath);
  if (!language) {
    throw new ParseError(`Unsupported language for ${filePath}`);
  }
  return { symbols: parseSymbols(source, language), language };
}

/**
 * Compute the semantic delta between two states of a file.
 * `pre`/`post` may be `null` when the file did not exist in that state.
 */
export function computeDelta(
  filePath: string,
  pre: SymbolInfo[] | null,
  post: SymbolInfo[] | null,
): FileDelta {
  const preList = pre ?? [];
  const postList = post ?? [];

  const changes: ASTDelta[] = [];
  const nodeId = (s: SymbolInfo) => `${filePath}${s.id}`;

  if (!pre) {
    return {
      filePath,
      pre: preList,
      post: postList,
      changes: [
        {
          filePath,
          type: "ADDED",
          nodeIds: postList.map(nodeId),
          summary:
            postList.length > 0
              ? `Added file with ${postList.length} symbol(s)`
              : "Added file (no symbols)",
        },
      ],
    };
  }
  if (postList.length === 0 && preList.length > 0) {
    return {
      filePath,
      pre: preList,
      post: postList,
      changes: [
        {
          filePath,
          type: "DELETED",
          nodeIds: preList.map(nodeId),
          summary: "Deleted file",
        },
      ],
    };
  }

  const preByName = new Map(preList.map((s) => [s.name, s]));
  const matchedPre = new Set<SymbolInfo>();

  // 1) exact-name matches -> MODIFIED / MOVED
  for (const post of postList) {
    const pre = preByName.get(post.name);
    if (!pre) continue;
    matchedPre.add(pre);
    if (pre.bodyHash !== post.bodyHash) {
      changes.push({
        filePath,
        type: "MODIFIED",
        nodeIds: [nodeId(pre), nodeId(post)],
        summary: `${post.kind} "${post.name}" modified`,
      });
    } else if (pre.startLine !== post.startLine) {
      changes.push({
        filePath,
        type: "MOVED",
        nodeIds: [nodeId(pre), nodeId(post)],
        summary: `${post.kind} "${post.name}" moved from line ${pre.startLine} to ${post.startLine}`,
      });
    }
  }

  // 2) rename detection: same body hash, different name
  const unmatchedPre = preList.filter((s) => !matchedPre.has(s));
  const unmatchedPost = postList.filter((s) => !preByName.has(s.name));
  const byHash = new Map<string, SymbolInfo[]>();
  for (const s of unmatchedPre) {
    const arr = byHash.get(s.bodyHash) ?? [];
    arr.push(s);
    byHash.set(s.bodyHash, arr);
  }
  const renamedPost = new Set<SymbolInfo>();
  for (const post of unmatchedPost) {
    const cands = byHash.get(post.bodyHash) ?? [];
    if (cands.length === 1) {
      const pre = cands[0]!;
      matchedPre.add(pre);
      byHash.delete(pre.bodyHash);
      renamedPost.add(post);
      changes.push({
        filePath,
        type: "RENAMED",
        nodeIds: [nodeId(pre), nodeId(post)],
        summary: `${pre.kind} "${pre.name}" renamed to "${post.name}"`,
      });
    }
  }

  // 3) ADDED / DELETED
  for (const s of unmatchedPost) {
    if (!renamedPost.has(s)) {
      changes.push({
        filePath,
        type: "ADDED",
        nodeIds: [nodeId(s)],
        summary: `${s.kind} "${s.name}" added (line ${s.startLine})`,
      });
    }
  }
  for (const s of unmatchedPre) {
    if (!matchedPre.has(s)) {
      changes.push({
        filePath,
        type: "DELETED",
        nodeIds: [nodeId(s)],
        summary: `${s.kind} "${s.name}" deleted`,
      });
    }
  }

  if (changes.length === 0) {
    changes.push({
      filePath,
      type: "MODIFIED",
      nodeIds: [],
      summary: "File changed (text-level)",
    });
  }
  return { filePath, pre: preList, post: postList, changes };
}

function loadTypeScript(): typeof import("typescript") | null {
  try {
    return require_("typescript") as typeof import("typescript");
  } catch {
    return null;
  }
}

/**
 * Real syntax validation (the reason `drift realize` can promise that broken
 * code never enters history, PRD §9.2).
 *
 * TypeScript/JavaScript: parsed by the TypeScript compiler (transpile only —
 * no typechecking, so type errors never block commits).
 * Python: parsed with `ast` when a python interpreter is available.
 *
 * Returns a human-readable message for the first syntax error, or null when
 * the source is syntactically valid (or cannot be checked in this env).
 */
export function validateSyntax(
  source: string,
  language: SupportedLanguage,
): string | null {
  if (language === "typescript") {
    const ts = loadTypeScript();
    if (!ts) return null; // cannot check — structural checks in parseSymbols still apply
    const result = ts.transpileModule(source, {
      reportDiagnostics: true,
      compilerOptions: {
        allowJs: true,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.Preserve,
      },
    });
    const errors = (result.diagnostics ?? []).filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    if (errors.length > 0) {
      const first = errors[0]!;
      const line =
        first.start !== undefined
          ? source.slice(0, first.start).split(/\n/).length
          : 1;
      return `${ts.flattenDiagnosticMessageText(first.messageText, " ")} (line ${line})`;
    }
    return null;
  }
  if (language === "python") {
    for (const bin of ["python3", "python"]) {
      const res = spawnSync(
        bin,
        ["-c", "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", "-"],
        { input: source, encoding: "utf8", windowsHide: true, timeout: 10_000 },
      );
      if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (res.status === 0) return null;
      const msg = (res.stderr ?? "").toString().trim().split("\n").pop() ?? "invalid python";
      return msg.replace(/^\s*File "<stdin>", /, "");
    }
    return null;
  }
  return null;
}

/** Text-only delta for unsupported/binary files. */
export function textDelta(filePath: string, pre: string | null, post: string | null): FileDelta {
  let type: MutationType = "MODIFIED";
  if (!pre && post) type = "ADDED";
  else if (pre && !post) type = "DELETED";
  return {
    filePath,
    pre: [],
    post: [],
    changes: [
      {
        filePath,
        type,
        nodeIds: [],
        summary:
          type === "ADDED"
            ? "File added"
            : type === "DELETED"
              ? "File deleted"
              : "File changed (text-level, unsupported language or binary)",
      },
    ],
  };
}
