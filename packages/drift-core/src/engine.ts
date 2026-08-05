/**
 * The Drift engine: orchestrates every command. Used by the CLI and wrapped
 * by the SDK. The MCP server delegates here through the CLI (PRD §11 contract).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createPublicKey } from "node:crypto";
import { dirname, join, relative as relPath, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  computeDelta,
  detectLanguage,
  isBinary,
  parseSymbols,
  ParseError,
  textDelta,
  validateSyntax,
  type ASTDelta,
  type SymbolInfo,
} from "@drift/ast";
import { canonicalJson, generateKeyPair, newIntentId, sha256Hex, signPayload, verifyPayload } from "./crypto.js";
import { CONFIG_TEMPLATE, loadConfig, type DriftConfig } from "./config.js";
import { DriftError, EXIT, NotInitializedError } from "./errors.js";
import {
  blameLine,
  checkout,
  commit,
  commitExists,
  currentHead,
  execGit,
  findRepoRoot,
  gitIdentity,
  gitLogMessages,
  readFileAt,
  stageAll,
  stagedNameStatus,
  unstage,
} from "./git.js";
import { IntentStore, type IntentRecord, type LogEntry } from "./store.js";
import { compilePatterns, redact, type RedactResult } from "./redact.js";

export interface RealizeOptions {
  prompt: string;
  files?: string[];
  model?: string;
  author?: string;
  authorType?: "HUMAN" | "AGENT";
  agentState?: string; // base64 JSON
  verifyCmd?: string;
  noAst?: boolean;
}

export interface RealizeResult {
  gitSha: string;
  intentId: string;
  astDelta: ASTDelta[];
  redactions: number;
}

export interface BlameResult {
  file: string;
  line: number;
  functionName?: string;
  gitSha: string;
  committed: boolean;
  intent: (IntentRecord & { signatureValid: boolean }) | null;
  baseline: boolean;
}

export interface VerifyResult {
  intentId: string;
  verifyCmd: string | null;
  status: "pass" | "fail" | "no-command";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ReplayResult {
  intentId: string;
  gitSha: string;
  agentState: string | null;
  checkedOut: boolean;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  orphanIds: string[];
  fixed: string[];
}

export interface InitResult {
  repoRoot: string;
  driftDir: string;
  publicKeyPem: string;
}

export class Drift {
  readonly repoRoot: string;
  readonly driftDir: string;
  readonly config: DriftConfig;
  private store: IntentStore;
  private privateKeyPem: string;
  private publicKeyPem: string;
  private redactionPatterns: RegExp[];

  private constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.driftDir = join(repoRoot, ".drift");
    this.config = loadConfig(this.driftDir);
    this.redactionPatterns = compilePatterns(this.config.redaction.patterns);
    this.store = IntentStore.open(join(this.driftDir, "drift.db"));
    const keys = this.loadKeys();
    this.privateKeyPem = keys.privateKeyPem;
    this.publicKeyPem = keys.publicKeyPem;
  }

  // ------------------------------------------------------------------ setup
  static fromCwd(cwd: string): Drift {
    const root = findRepoRoot(cwd, process.env.DRIFT_REPO);
    if (!root) throw new DriftError("Not inside a git repository");
    const driftDir = join(root, ".drift");
    if (!existsSync(driftDir)) throw new NotInitializedError();
    return new Drift(root);
  }

  static init(cwd: string, opts: { author?: string } = {}): InitResult {
    const root = findRepoRoot(cwd, process.env.DRIFT_REPO);
    if (!root) throw new DriftError("Not inside a git repository");
    const driftDir = join(root, ".drift");
    if (!existsSync(driftDir)) {
      mkdirSync(join(driftDir, "objects"), { recursive: true });
      mkdirSync(join(driftDir, "keys"), { recursive: true });
      writeFileSync(join(driftDir, "config.toml"), CONFIG_TEMPLATE);
      writeFileSync(
        join(driftDir, ".gitignore"),
        "keys/\n",
      );
    }
    const keysDir = join(driftDir, "keys");
    const keyPath = join(keysDir, "ed25519.pem");
    let keyPair: { privateKeyPem: string; publicKeyPem: string };
    if (existsSync(keyPath)) {
      const privateKeyPem = readFileSync(keyPath, "utf8");
      keyPair = { privateKeyPem, publicKeyPem: publicKeyFromPrivate(privateKeyPem) };
    } else {
      keyPair = generateKeyPair();
      writeFileSync(keyPath, keyPair.privateKeyPem, { mode: 0o600 });
    }

    const drift = new Drift(root);
    drift.store.setMeta("schema_version", "1");
    drift.store.setMeta("public_key", keyPair.publicKeyPem.trim());
    drift.store.setMeta("created_at", String(Date.now()));
    if (opts.author) drift.store.setMeta("default_author", opts.author);
    drift.close();
    return {
      repoRoot: root,
      driftDir,
      publicKeyPem: keyPair.publicKeyPem.trim(),
    };
  }

  private loadKeys(): { privateKeyPem: string; publicKeyPem: string } {
    const keyPath = join(this.driftDir, "keys", "ed25519.pem");
    if (!existsSync(keyPath)) {
      throw new DriftError(
        "Drift signing key missing. Run `drift init` to regenerate.",
        EXIT.KEY,
      );
    }
    const privateKeyPem = readFileSync(keyPath, "utf8");
    return { privateKeyPem, publicKeyPem: publicKeyFromPrivate(privateKeyPem) };
  }

  close(): void {
    this.store.close();
  }

  get publicKey(): string {
    return this.publicKeyPem;
  }

  // ---------------------------------------------------------------- realize
  realize(opts: RealizeOptions): RealizeResult {
    const prompt = (opts.prompt ?? "").trim();
    if (!prompt) {
      throw new DriftError("realize requires a prompt: drift realize -p \"what did you change and why\"");
    }

    stageAll(this.repoRoot, opts.files);
    const staged = stagedNameStatus(this.repoRoot);
    if (staged.length === 0) {
      throw new DriftError(
        "No changes to realize. Edit (or stage) a file first.",
        EXIT.NO_CHANGES,
      );
    }

    const head = currentHead(this.repoRoot);
    const deltas: ASTDelta[] = [];
    const syntaxErrors: { file: string; message: string }[] = [];

    for (const { status, path } of staged) {
      // Deleted files have no working-tree content; record a DELETED delta.
      if (status === "D") {
        const pre = head ? readFileAt(this.repoRoot, path, head) : null;
        deltas.push(...textDelta(path, pre, null).changes);
        continue;
      }
      let post: Buffer;
      try {
        post = readFileSync(resolve(this.repoRoot, path));
      } catch {
        continue; // unreadable (e.g. race with another process)
      }
      const postText = post.toString("utf8");
      const pre = head ? readFileAt(this.repoRoot, path, head) : null;
      const preBuffer = pre ? Buffer.from(pre, "utf8") : null;
      const binary = isBinary(post) || (preBuffer ? isBinary(preBuffer) : false);
      if (binary) {
        deltas.push(...textDelta(path, pre, postText).changes);
        continue;
      }
      const lang = detectLanguage(path);
      if (!lang || opts.noAst) {
        deltas.push(...textDelta(path, pre, postText).changes);
        continue;
      }
      try {
        const syntaxErr = validateSyntax(postText, lang);
        if (syntaxErr) {
          syntaxErrors.push({ file: path, message: syntaxErr });
          continue;
        }
        const preSyms: SymbolInfo[] | null =
          pre === null ? null : parseSymbols(pre, lang);
        const postSyms: SymbolInfo[] = parseSymbols(postText, lang);
        deltas.push(...computeDelta(path, preSyms, postSyms).changes);
      } catch (err) {
        if (err instanceof ParseError) {
          syntaxErrors.push({ file: path, message: err.message });
        } else {
          throw err;
        }
      }
    }

    if (syntaxErrors.length > 0) {
      unstage(this.repoRoot);
      throw new DriftError(
        `Syntax error — commit aborted, no history was polluted:\n  - ${syntaxErrors
          .map((e) => `${e.file}: ${e.message}`)
          .join("\n  - ")}\nFix the code and run realize again.`,
        EXIT.SYNTAX,
      );
    }

    const redactionResult: RedactResult = redact(prompt, this.redactionPatterns);
    const safePrompt = redactionResult.text;
    const safeState = opts.agentState
      ? redact(opts.agentState, this.redactionPatterns).text
      : undefined;

    const headId = this.store.getHead();
    const timestamp = Date.now();
    const id = newIntentId();
    const authorId = opts.author ?? (gitIdentity(this.repoRoot, "user.name") || "unknown");
    const author = {
      type: (opts.authorType ?? (opts.model ? "AGENT" : "HUMAN")) as "HUMAN" | "AGENT",
      identifier: authorId,
      model: opts.model,
    };

    const intentBase = {
      id,
      parentId: headId,
      author,
      prompt: safePrompt,
      astDelta: deltas,
      agentState: safeState,
      verifyCmd: opts.verifyCmd,
      timestamp,
    };
    const canonical = canonicalJson(intentBase);
    const signature = signPayload(canonical, this.privateKeyPem);
    const objectSha = sha256Hex(canonical);
    // Store the path relative to the repo root so committed `.drift` metadata
    // stays portable across machines (ADR-007).
    const objectPath = join(
      ".drift",
      "objects",
      objectSha.slice(0, 2),
      `${objectSha.slice(2)}.json`,
    );
    const absObjectPath = join(this.repoRoot, objectPath);
    mkdirSync(dirname(absObjectPath), { recursive: true });
    const objectData = JSON.stringify({ ...intentBase, gitCommitSha: "", signature }, null, 2);
    const tmpPath = `${absObjectPath}.tmp-${process.pid}`;
    writeFileSync(tmpPath, objectData);
    renameSync(tmpPath, absObjectPath);

    const gitSha = commit(
      this.repoRoot,
      `${safePrompt}\n\nDrift-Intent: ${id}`,
    );

    const intent: IntentRecord = {
      ...intentBase,
      gitCommitSha: gitSha,
      objectPath: objectPath.replace(/\\/g, "/"),
      signature,
    };
    try {
      this.store.insertIntent(intent);
    } catch (err) {
      // Commit landed but intent recording failed — surface it so the user can
      // run `drift doctor` (trailer-backref check) instead of a bare error.
      throw new DriftError(
        `git commit landed (${gitSha}) but intent recording failed: ${err instanceof Error ? err.message : String(err)}. Run \`drift doctor\` to reconcile.`,
      );
    }
    this.store.setHead(id);

    return { gitSha, intentId: id, astDelta: deltas, redactions: redactionResult.count };
  }

  // -------------------------------------------------------------------- log
  log(filters: { author?: string; model?: string; file?: string; limit?: number } = {}): LogEntry[] {
    return this.store.listIntents(filters);
  }

  // ------------------------------------------------------------------ blame
  blame(filePath: string, opts: { line?: number; functionName?: string } = {}): BlameResult {
    const file = resolve(this.repoRoot, filePath);
    const relative = relPath(this.repoRoot, file).replace(/\\/g, "/");
    let line = opts.line;
    let functionName: string | undefined;
    if (opts.functionName) {
      const source = readFileSync(file, "utf8");
      const lang = detectLanguage(relative);
      if (!lang) throw new DriftError(`Unsupported language: ${relative}`);
      const symbols = parseSymbols(source, lang);
      const symbol = symbols.find((s) => s.name === opts.functionName);
      if (!symbol) {
        throw new DriftError(`Function "${opts.functionName}" not found in ${relative}`);
      }
      line = symbol.startLine;
      functionName = opts.functionName;
    }
    if (!line) throw new DriftError("blame requires --line N or --function NAME");
    const totalLines = readFileSync(file, "utf8").split("\n").length;
    if (line < 1 || line > totalLines) {
      throw new DriftError(`Line ${line} is out of range (1..${totalLines})`);
    }

    const sha = blameLine(this.repoRoot, relative, line);
    if (!sha) {
      throw new DriftError(`Could not blame ${relative}:${line}`);
    }
    const committed = sha !== "0000000000000000000000000000000000000000";
    let intent: (IntentRecord & { signatureValid: boolean }) | null = null;
    if (committed) {
      const record = this.store.findByGitSha(sha);
      if (record) {
        const obj = this.store.readObjectRecord(record.objectPath);
        const canonical = obj
          ? canonicalJson({
              id: (obj.id as string) ?? record.id,
              parentId: (obj.parentId as string | null) ?? record.parentId,
              author: obj.author ?? record.author,
              prompt: (obj.prompt as string) ?? record.prompt,
              astDelta: obj.astDelta ?? record.astDelta,
              agentState: obj.agentState ?? record.agentState,
              verifyCmd: obj.verifyCmd ?? record.verifyCmd,
              timestamp: (obj.timestamp as number) ?? record.timestamp,
            })
          : "";
        const signature = (obj?.signature as string | undefined) ?? record.signature;
        intent = {
          ...record,
          signatureValid: signature ? verifyPayload(canonical, this.publicKeyPem, signature) : false,
        };
      }
    }
    return {
      file: relative,
      line,
      functionName,
      gitSha: committed ? sha : "uncommitted",
      committed,
      intent,
      baseline: committed && intent === null,
    };
  }

  // --------------------------------------------------------------- context
  context(filePath: string, limit = 5): LogEntry[] {
    return this.store.contextForFile(filePath, limit);
  }

  // ---------------------------------------------------------------- verify
  verify(intentId: string): VerifyResult {
    const intent = this.store.getById(intentId);
    if (!intent) throw new DriftError(`Intent not found: ${intentId}`);
    if (!intent.verifyCmd) {
      return { intentId, verifyCmd: null, status: "no-command", exitCode: null, stdout: "", stderr: "" };
    }
    // NOTE: verifyCmd executes with the user's shell. Only run `drift verify`
    // on intents you trust (local or from a trusted upstream).
    const res = spawnSync(intent.verifyCmd, {
      cwd: this.repoRoot,
      shell: true,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      intentId,
      verifyCmd: intent.verifyCmd,
      status: res.status === 0 ? "pass" : "fail",
      exitCode: res.status,
      stdout: (res.stdout ?? "").toString(),
      stderr: (res.stderr ?? "").toString(),
    };
  }

  // ---------------------------------------------------------------- replay
  replay(intentId: string, opts: { checkout?: boolean } = {}): ReplayResult {
    const intent = this.store.getById(intentId);
    if (!intent) throw new DriftError(`Intent not found: ${intentId}`);
    if (opts.checkout) {
      checkout(this.repoRoot, intent.gitCommitSha);
    }
    return {
      intentId,
      gitSha: intent.gitCommitSha,
      agentState: intent.agentState ?? null,
      checkedOut: Boolean(opts.checkout),
    };
  }

  // ---------------------------------------------------------------- doctor
  doctor(opts: { fix?: boolean } = {}): DoctorResult {
    const checks: DoctorCheck[] = [];
    const orphanIds: string[] = [];
    const fixed: string[] = [];

    const integrity = this.store.integrityCheck();
    checks.push({ name: "sqlite-integrity", ok: integrity === "ok", detail: integrity });

    const head = this.store.getHead();
    if (head) {
      checks.push({ name: "head", ok: Boolean(this.store.getById(head)), detail: `head = ${head}` });
    } else {
      checks.push({ name: "head", ok: true, detail: "no intents yet" });
    }

    const storedPub = this.store.getMeta("public_key");
    checks.push({
      name: "signing-key",
      ok: storedPub === this.publicKey.trim(),
      detail: storedPub === this.publicKey.trim() ? "key matches DAG header" : "key mismatch",
    });

    // orphan intents: row present but git commit gone
    for (const row of this.store.allRows()) {
      const commitOk = commitExists(this.repoRoot, row.git_sha);
      const objectOk = existsSync(resolve(this.repoRoot, row.object_path));
      if (!commitOk) orphanIds.push(row.id);
      if (!commitOk || !objectOk) {
        checks.push({
          name: "intent",
          ok: false,
          detail: `${row.id}: ${!commitOk ? "git commit missing" : ""}${!objectOk ? " object file missing" : ""}`.trim(),
        });
        if (opts.fix) {
          this.store.deleteById(row.id);
          fixed.push(`deleted row ${row.id}`);
        }
      }
    }

    // commits with Drift-Intent trailer but no stored row
    const trailerOnly: string[] = [];
    for (const { sha, body } of gitLogMessages(this.repoRoot)) {
      const m = /Drift-Intent:\s*(did_[0-9a-f]+)/.exec(body);
      if (m) {
        const id = m[1]!;
        if (!this.store.getById(id)) trailerOnly.push(sha.slice(0, 8));
      }
    }
    checks.push({
      name: "trailer-backrefs",
      ok: trailerOnly.length === 0,
      detail: trailerOnly.length
        ? `commits with missing intent rows: ${trailerOnly.join(", ")}`
        : "all Drift-Intent trailers resolve",
    });

    const ws = execGit(this.repoRoot, ["status", "--porcelain", "--", ".", ":(exclude).drift"], true);
    const dirty = ws.stdout.trim();
    checks.push({
      name: "worktree",
      ok: true,
      detail: dirty ? `${dirty.split("\n").length} uncommitted change(s) present` : "clean",
    });

    return { checks, orphanIds, fixed };
  }

  // ---------------------------------------------------------------- export
  exportJson(): string {
    const entries = this.store
      .listIntents({})
      .map((e) => ({
        id: e.id,
        gitSha: e.gitSha,
        authorType: e.authorType,
        authorId: e.authorId,
        model: e.model,
        prompt: e.prompt,
        timestamp: new Date(e.timestamp).toISOString(),
        files: e.files,
      }));
    return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), intents: entries }, null, 2);
  }

  verifyIntentSignature(intentId: string): { ok: boolean; detail: string } {
    const intent = this.store.getById(intentId);
    if (!intent) return { ok: false, detail: "not found" };
    const obj = this.store.readObjectRecord(intent.objectPath);
    if (!obj?.signature) return { ok: false, detail: "object or signature missing" };
    const canonical = obj
      ? canonicalJson({
          id: obj.id,
          parentId: obj.parentId,
          author: obj.author,
          prompt: obj.prompt,
          astDelta: obj.astDelta,
          agentState: obj.agentState,
          verifyCmd: obj.verifyCmd,
          timestamp: obj.timestamp,
        })
      : "";
    const valid = verifyPayload(canonical, this.publicKeyPem, obj.signature as string);
    return { ok: valid, detail: valid ? "valid" : "invalid" };
  }
}

function publicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
}
