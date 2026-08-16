/**
 * The Drift engine: orchestrates every command. Used by the CLI and wrapped
 * by the SDK. The MCP server delegates here through the CLI (PRD §11 contract).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createPublicKey } from "node:crypto";
import { dirname, isAbsolute, join, relative as relPath, resolve } from "node:path";
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
  type MutationType,
  type SymbolInfo,
} from "@drift/ast";
import {
  canonicalJson,
  decryptAesGcm,
  deriveMasterKey,
  encryptAesGcm,
  generateKeyPair,
  isEncrypted,
  newIntentId,
  sha256Hex,
  signPayload,
  verifyPayload,
} from "./crypto.js";
import { CONFIG_TEMPLATE, loadConfig, type DriftConfig, type PromptMode } from "./config.js";
import { DriftError, EXIT, NotInitializedError } from "./errors.js";
import {
  blameLine,
  blameLines,
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
import {
  buildPublicSummary,
  PUBLIC_FILES_MAX,
  PublicStore,
  sanitizePublicText,
  type PublicIntentView,
  type UnsignedPublicIntentView,
} from "./public.js";
import { extractDriftIntentIds } from "./trailers.js";

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
  intent: (IntentRecord & { signatureValid: boolean; summary: string }) | null;
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

export interface DriftStatus {
  initialized: boolean;
  repoRoot: string | null;
  /** Why status is not fully initialized. */
  reason?: "no-git" | "not-initialized";
  intents?: number;
  head?: string | null;
  encryption?: boolean;
  promptMode?: PromptMode;
  gitBranch?: string | null;
  gitHead?: string | null;
  gitDirty?: boolean;
  lastIntent?: { id: string; timestamp: number; summary: string } | null;
}

export class Drift {
  readonly repoRoot: string;
  readonly driftDir: string;
  readonly config: DriftConfig;
  /**
   * Private SQLite intent store. `null` in public-only mode (fresh clone,
   * ADR-009): read commands then serve from the committed public manifests.
   */
  private store: IntentStore | null;
  private publicStore: PublicStore;
  private privateKeyPem: string;
  private publicKeyPem: string;
  private redactionPatterns: RegExp[];
  private readonly publicOnly: boolean;

  /**
   * @param opts.forceStore open the private store even when drift.db is
   *   absent (used by `init`, which creates it).
   */
  private constructor(repoRoot: string, opts: { forceStore?: boolean } = {}) {
    this.repoRoot = repoRoot;
    this.driftDir = join(repoRoot, ".drift");
    this.config = loadConfig(this.driftDir);
    this.redactionPatterns = compilePatterns(this.config.redaction.patterns);
    this.publicStore = new PublicStore(this.driftDir);
    const dbPath = join(this.driftDir, "drift.db");
    this.publicOnly = !opts.forceStore && !existsSync(dbPath);
    if (this.publicOnly) {
      this.store = null;
      this.privateKeyPem = "";
      this.publicKeyPem = this.publicStore.publicKey() ?? "";
    } else {
      try {
        this.store = IntentStore.open(dbPath);
      } catch (err) {
        // A corrupted SQLite file surfaces as an opaque driver error; report it
        // as a corrupt DAG (PRD §14.1 exit 5) instead of a generic error 1.
        throw new DriftError(
          `Drift database is corrupt or unreadable (${this.driftDir}/drift.db): ${err instanceof Error ? err.message : String(err)}. Restore it from a backup or run \`git clean -fdx .drift\` + \`drift init\` to start fresh.`,
          EXIT.CORRUPT,
        );
      }
      const keys = this.loadKeys();
      this.privateKeyPem = keys.privateKeyPem;
      this.publicKeyPem = keys.publicKeyPem;
    }
  }

  // ---------------------------------------------------------- encryption
  /** DRIFT_MASTER_KEY → 32-byte AES key, or null when not set (PRD §17.2). */
  private getMasterKey(): Buffer | null {
    const secret = process.env.DRIFT_MASTER_KEY;
    return secret ? deriveMasterKey(secret) : null;
  }

  /** Throw E_KEY (exit 4) when encryption is enabled but the key is missing. */
  private masterKeyOrThrow(): Buffer {
    const key = this.getMasterKey();
    if (!key) {
      throw new DriftError(
        "Encryption is enabled in .drift/config.toml but DRIFT_MASTER_KEY is not set. Set the environment variable or disable encryption.",
        EXIT.KEY,
      );
    }
    return key;
  }

  /**
   * Decrypt a stored value when it is an encrypted payload (AAD-bound to the
   * intent id). Legacy plaintext passes through untouched. Without a key:
   * readable fields degrade to a placeholder; `replay`/`verify` fail hard
   * with E_KEY instead.
   */
  private decryptText(value: string, aad?: string): string {
    if (!isEncrypted(value)) return value; // legacy plaintext (v0.1.0)
    const key = this.getMasterKey();
    if (!key) return "[encrypted]";
    try {
      return decryptAesGcm(value, key, aad);
    } catch {
      return "[encrypted:invalid-key-or-corrupt]";
    }
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
    const firstTime = !existsSync(driftDir);
    if (firstTime) {
      mkdirSync(join(driftDir, "objects"), { recursive: true });
      mkdirSync(join(driftDir, "keys"), { recursive: true });
      mkdirSync(join(driftDir, "public", "intents"), { recursive: true });
      writeFileSync(join(driftDir, "config.toml"), CONFIG_TEMPLATE);
    }
    // Idempotent merge: never deletes user lines, only ensures the ADR-009
    // ignore rules are present so `git add .` can never stage private data.
    ensureDriftGitignore(driftDir);
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

    const drift = new Drift(root, { forceStore: true });
    const store = drift.requireStore("drift init");
    store.setMeta("schema_version", "1");
    store.setMeta("public_key", keyPair.publicKeyPem.trim());
    store.setMeta("created_at", String(Date.now()));
    if (opts.author) store.setMeta("default_author", opts.author);
    // Commit the public key so fresh clones can verify manifest signatures.
    drift.publicStore.writePublicKey(keyPair.publicKeyPem.trim());
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
    this.store?.close();
  }

  /** The private store, or a clear error naming the command that needs it. */
  private requireStore(command: string): IntentStore {
    if (!this.store) {
      throw new DriftError(
        `No local Drift store in this clone — \`${command}\` needs private local data. Run \`drift init\` to create the local intent store and signing key.`,
        EXIT.KEY,
      );
    }
    return this.store;
  }

  get publicKey(): string {
    return this.publicKeyPem;
  }

  // ---------------------------------------------------------------- status
  /**
   * First-run friendly status: always succeeds as a read, reports whether the
   * repo is initialized and what the next step is. Never throws for missing
   * init (a corrupted store still surfaces as exit 5).
   */
  static status(cwd: string): DriftStatus {
    const root = findRepoRoot(cwd, process.env.DRIFT_REPO);
    if (!root) {
      return { initialized: false, repoRoot: null, reason: "no-git" };
    }
    const driftDir = join(root, ".drift");
    if (!existsSync(driftDir)) {
      return { initialized: false, repoRoot: root, reason: "not-initialized" };
    }
    const drift = new Drift(root);
    try {
      const last = drift.log({ limit: 1 })[0] ?? null;
      const branchRes = execGit(root, ["branch", "--show-current"], true);
      const headRes = execGit(root, ["rev-parse", "--short", "HEAD"], true);
      const ws = execGit(root, ["status", "--porcelain", "--", ".", ":(exclude).drift"], true);
      return {
        initialized: true,
        repoRoot: root,
        intents: drift.store ? drift.store.allRows().length : drift.publicStore.list().length,
        head: drift.store?.getHead() ?? null,
        encryption: drift.config.encryption.enabled,
        promptMode: drift.config.prompts.mode,
        gitBranch: branchRes.status === 0 ? branchRes.stdout.trim() : null,
        gitHead: headRes.status === 0 ? headRes.stdout.trim() : null,
        gitDirty: ws.stdout.trim().length > 0,
        lastIntent: last
          ? { id: last.id, timestamp: last.timestamp, summary: last.summary ?? "" }
          : null,
      };
    } finally {
      drift.close();
    }
  }

  // ---------------------------------------------------------------- realize
  realize(opts: RealizeOptions): RealizeResult {
    const store = this.requireStore("drift realize");
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

    const headId = store.getHead();
    const timestamp = Date.now();
    const id = newIntentId();
    const authorId = opts.author ?? (gitIdentity(this.repoRoot, "user.name") || "unknown");
    const author = {
      type: (opts.authorType ?? (opts.model ? "AGENT" : "HUMAN")) as "HUMAN" | "AGENT",
      identifier: authorId,
      model: opts.model,
    };

    // v0.2.0 encryption at rest: when enabled, the intent's prompt and agent
    // state are AES-256-GCM encrypted (AAD-bound to the intent id) before they
    // are stored. The git commit message keeps the plaintext prompt so history
    // stays readable; the signature covers the stored (encrypted) canonical
    // form, so verification never requires the master key.
    const encKey = this.config.encryption.enabled ? this.masterKeyOrThrow() : null;
    // Prompt storage modes (PRD §17.x, docs/architecture.md):
    //   commit-summary (default) — full prompt only in local .drift (gitignored);
    //                              the git commit message carries a safe summary.
    //   full                     — full prompt in the commit message too (legacy).
    //   none                     — prompt text is not persisted anywhere.
    // The summary is derived from the ALREADY-redacted prompt, so a secret in
    // the first line is redacted before it can reach the commit message.
    const mode: PromptMode = this.config.prompts.mode;
    const storePrompt = mode !== "none";
    const storedPrompt = storePrompt
      ? encKey
        ? encryptAesGcm(safePrompt, encKey, id)
        : safePrompt
      : "";
    const storedState =
      encKey && safeState !== undefined ? encryptAesGcm(safeState, encKey, id) : safeState;
    const commitMessage = buildCommitMessage(safePrompt, id, {
      mode,
      model: opts.model,
      verifyCmd: opts.verifyCmd,
    });

    const intentBase = {
      id,
      parentId: headId,
      author,
      prompt: storedPrompt,
      astDelta: deltas,
      agentState: storedState,
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

    const gitSha = commit(this.repoRoot, commitMessage);

    const intent: IntentRecord = {
      ...intentBase,
      gitCommitSha: gitSha,
      objectPath: objectPath.replace(/\\/g, "/"),
      signature,
    };
    try {
      store.insertIntent(intent);
    } catch (err) {
      // Commit landed but intent recording failed — surface it so the user can
      // run `drift doctor` (trailer-backref check) instead of a bare error.
      throw new DriftError(
        `git commit landed (${gitSha}) but intent recording failed: ${err instanceof Error ? err.message : String(err)}. Run \`drift doctor\` to reconcile.`,
      );
    }
    store.setHead(id);

    // ADR-009: persist the public (safe, signed) provenance view so fresh
    // clones and the GitHub Action/App can show intent metadata without any
    // private data. In `none` mode the summary stays empty — nothing derived
    // from the prompt may persist anywhere.
    const publicView: UnsignedPublicIntentView = {
      schemaVersion: 1,
      id,
      summary: mode === "none" ? "" : buildPublicSummary(safePrompt),
      model: opts.model,
      agent: { type: author.type, identifier: author.identifier },
      verification: opts.verifyCmd,
      files: deltas
        .slice(0, PUBLIC_FILES_MAX)
        .map((d) => ({ path: d.filePath, mutationType: d.type, summary: d.summary || undefined })),
      commit: gitSha,
      timestamp,
    };
    this.publicStore.write(publicView, this.privateKeyPem);

    return { gitSha, intentId: id, astDelta: deltas, redactions: redactionResult.count };
  }

  // -------------------------------------------------------------------- log
  log(filters: { author?: string; model?: string; file?: string; limit?: number } = {}): LogEntry[] {
    if (this.store) {
      return this.store.listIntents(filters).map((e) => {
        const prompt = this.decryptText(e.prompt, e.id);
        return { ...e, prompt, summary: this.summaryFor(e.id, prompt) };
      });
    }
    // Public-only (fresh clone): serve the committed public manifests.
    let views = this.publicStore.list();
    if (filters.author) {
      views = views.filter((v) => v.agent?.identifier === filters.author);
    }
    if (filters.model) {
      views = views.filter((v) => v.model === filters.model);
    }
    if (filters.file) {
      views = views.filter((v) =>
        (v.files ?? []).some((f) => f.path === filters.file || f.path.startsWith(`${filters.file}/`)),
      );
    }
    const limit = filters.limit !== undefined ? safeClamp(filters.limit, 100) : 100;
    return views.slice(0, limit).map(publicViewToLogEntry);
  }

  /** Safe public summary for an intent: manifest first, then derived. */
  summaryFor(id: string, localPrompt: string): string {
    const view = this.publicStore.getById(id);
    if (view) return view.summary;
    // Pre-ADR-009 local intent with no manifest yet — derive a safe summary
    // from the (already redacted) stored prompt.
    return localPrompt ? buildPublicSummary(sanitizePublicText(localPrompt)) : "";
  }

  // ------------------------------------------------------------------ blame
  blame(filePath: string, opts: { line?: number; functionName?: string } = {}): BlameResult {
    const file = resolve(this.repoRoot, filePath);
    const relative = relPath(this.repoRoot, file).replace(/\\/g, "/");
    // The CLI/MCP must never read files outside the repository root — reject
    // `../` traversal, absolute paths, cross-drive paths, and symlinks that
    // escape the repo before touching the filesystem (blame previously read
    // the file first).
    if (!isInsideRepo(this.repoRoot, file)) {
      throw new DriftError(`Path escapes the repository root: ${filePath}`);
    }
    let line = opts.line;
    let functionName: string | undefined;
    let functionEndLine: number | undefined;
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
      functionEndLine = symbol.endLine;
      functionName = opts.functionName;
    }
    if (!line) throw new DriftError("blame requires --line N or --function NAME");
    const totalLines = readFileSync(file, "utf8").split("\n").length;
    if (line < 1 || line > totalLines) {
      throw new DriftError(`Line ${line} is out of range (1..${totalLines})`);
    }

    let sha: string;
    if (functionName) {
      // Attribute the intent whose commit touched ANY line of the function
      // body (PRD §7.3: map git blame sha → intent). The signature line often
      // predates the modification, so walking the body span finds the intent
      // that actually changed the function; untouched functions still resolve
      // to "pre-Drift baseline".
      const end = Math.min(functionEndLine ?? line, totalLines);
      const lineShas = blameLines(this.repoRoot, relative, line, end);
      let fallback = "";
      let fallbackLine = 0;
      let chosen = "";
      for (let ln = end; ln >= line; ln--) {
        const s = lineShas.get(ln);
        if (!s) continue;
        if (!fallback) {
          fallback = s;
          fallbackLine = ln;
        }
        if (this.store?.findByGitSha(s) || this.publicStore.findByCommit(s)) {
          chosen = s;
          line = ln;
          break;
        }
      }
      sha = chosen || fallback;
      if (!sha) {
        throw new DriftError(`Could not blame ${relative}:${line}`);
      }
      // Baseline case: report the line that actually owns the fallback sha
      // instead of the function's start line.
      if (!chosen && fallbackLine) line = fallbackLine;
    } else {
      sha = blameLine(this.repoRoot, relative, line);
      if (!sha) {
        throw new DriftError(`Could not blame ${relative}:${line}`);
      }
    }
    const committed = sha !== "0000000000000000000000000000000000000000";
    let intent: (IntentRecord & { signatureValid: boolean; summary: string }) | null = null;
    if (committed) {
      let record: IntentRecord | null = this.store?.findByGitSha(sha) ?? null;
      let signatureValid = false;
      if (!record) {
        // Fresh clone (no private DB): resolve via the committed manifest.
        const view = this.publicStore.findByCommit(sha);
        if (view) {
          record = publicViewToIntentRecord(view);
          signatureValid = this.publicStore.verifySignature(view);
        }
      } else if (this.store) {
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
        signatureValid = signature ? verifyPayload(canonical, this.publicKeyPem, signature) : false;
      }
      if (record) {
        const prompt = this.decryptText(record.prompt, record.id);
        intent = {
          ...record,
          prompt,
          summary: this.summaryFor(record.id, prompt),
          signatureValid,
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
    // Same containment rule as blame: file arguments are repo-relative, and
    // normalising here also makes `./src/a.ts` and absolute in-repo paths
    // match the stored repo-relative intent paths.
    const file = resolve(this.repoRoot, filePath);
    const relative = relPath(this.repoRoot, file).replace(/\\/g, "/");
    if (!isInsideRepo(this.repoRoot, file)) {
      throw new DriftError(`Path escapes the repository root: ${filePath}`);
    }
    if (this.store) {
      return this.store.contextForFile(relative, limit).map((e) => {
        const prompt = this.decryptText(e.prompt, e.id);
        return { ...e, prompt, summary: this.summaryFor(e.id, prompt) };
      });
    }
    return this.publicStore
      .list()
      .filter((v) => (v.files ?? []).some((f) => f.path === relative))
      .slice(0, safeClamp(limit, 5))
      .map(publicViewToLogEntry);
  }

  // ---------------------------------------------------------------- verify
  verify(intentId: string): VerifyResult {
    const record = this.store ? this.store.getById(intentId) : null;
    const view = record ? null : this.publicStore.getById(intentId);
    if (!record && !view) throw new DriftError(`Intent not found: ${intentId}`);
    const verifyCmd = record?.verifyCmd ?? view?.verification ?? null;
    if (!verifyCmd) {
      return { intentId, verifyCmd: null, status: "no-command", exitCode: null, stdout: "", stderr: "" };
    }
    // NOTE: verifyCmd executes with the user's shell. Only run `drift verify`
    // on intents you trust (local or from a trusted upstream).
    const res = spawnSync(verifyCmd, {
      cwd: this.repoRoot,
      shell: true,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      intentId,
      verifyCmd,
      status: res.status === 0 ? "pass" : "fail",
      exitCode: res.status,
      stdout: (res.stdout ?? "").toString(),
      stderr: (res.stderr ?? "").toString(),
    };
  }

  // ---------------------------------------------------------------- replay
  replay(intentId: string, opts: { checkout?: boolean } = {}): ReplayResult {
    const store = this.requireStore("drift replay");
    const intent = store.getById(intentId);
    if (!intent) throw new DriftError(`Intent not found: ${intentId}`);
    if (opts.checkout) {
      checkout(this.repoRoot, intent.gitCommitSha);
    }
    let agentState = intent.agentState ?? null;
    if (agentState && isEncrypted(agentState)) {
      const key = this.getMasterKey();
      if (!key) {
        throw new DriftError(
          "Intent state is encrypted (v0.2.0). Set DRIFT_MASTER_KEY to replay it.",
          EXIT.KEY,
        );
      }
      try {
        agentState = decryptAesGcm(agentState, key, intent.id);
      } catch (err) {
        throw new DriftError(
          `Failed to decrypt agent state: ${err instanceof Error ? err.message : String(err)}`,
          EXIT.KEY,
        );
      }
    }
    return {
      intentId,
      gitSha: intent.gitCommitSha,
      agentState,
      checkedOut: Boolean(opts.checkout),
    };
  }

  // ---------------------------------------------------------------- doctor
  doctor(opts: { fix?: boolean } = {}): DoctorResult {
    const checks: DoctorCheck[] = [];
    const orphanIds: string[] = [];
    const fixed: string[] = [];

    // --- ADR-009 storage-safety checks (always run) -----------------------
    const untracked = this.untrackPrivateDriftFiles();
    checks.push({
      name: "gitignore-private",
      ok: untracked.length === 0,
      detail: untracked.length
        ? `not ignored: ${untracked.join(", ")} — run \`drift init\` to merge the ADR-009 ignore rules into .drift/.gitignore`
        : "drift.db, objects/, keys/ and private/ are gitignored",
    });

    const tracked = this.trackedPrivateDriftFiles();
    const untrackCmd = tracked.length
      ? `git rm --cached ${tracked.map(quotePath).join(" ")}`
      : "";
    checks.push({
      name: "tracked-private",
      ok: tracked.length === 0,
      detail: tracked.length
        ? `private Drift data is TRACKED: ${tracked.join(", ")}.\n  Fix: ${untrackCmd}\n  then commit. NOTE: this only untracks the current files — they remain in old commits' history.`
        : "no private Drift data is tracked by git",
    });

    const legacy = this.trackedPromptBearingObjects();
    checks.push({
      name: "legacy-objects",
      ok: legacy.length === 0,
      detail: legacy.length
        ? `tracked prompt-bearing objects found: ${legacy.join(", ")}.\n  Fix: ${`git rm --cached ${legacy.map(quotePath).join(" ")}`}\n  NOTE: this does not remove them from old git history.`
        : "no tracked prompt-bearing objects",
    });

    // --- public manifest integrity ---------------------------------------
    const views = this.publicStore.list();
    const badSigs = views.filter((v) => !this.publicStore.verifySignature(v));
    checks.push({
      name: "public-manifests",
      ok: badSigs.length === 0,
      detail: badSigs.length
        ? `${views.length} manifest(s) with invalid signatures: ${badSigs.map((v) => v.id).join(", ")}`
        : `${views.length} public manifest(s), all signatures valid`,
    });

    if (!this.store) {
      checks.push({
        name: "sqlite-store",
        ok: true,
        detail: "read-only clone: no private database present; serving from public manifests",
      });
      const ws = execGit(this.repoRoot, ["status", "--porcelain", "--", ".", ":(exclude).drift"], true);
      checks.push({
        name: "worktree",
        ok: true,
        detail: ws.stdout.trim() ? "uncommitted change(s) present" : "clean",
      });
      return { checks, orphanIds, fixed };
    }

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

    if (this.config.encryption.enabled) {
      const keyPresent = Boolean(process.env.DRIFT_MASTER_KEY);
      checks.push({
        name: "encryption-key",
        ok: keyPresent,
        detail: keyPresent
          ? `DRIFT_MASTER_KEY configured (provider: ${this.config.encryption.key_provider})`
          : `DRIFT_MASTER_KEY missing (provider: ${this.config.encryption.key_provider})`,
      });
    }

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

    // commits with Drift-Intent trailer but no stored row / manifest
    const trailerOnly: string[] = [];
    for (const { sha, body } of gitLogMessages(this.repoRoot)) {
      for (const id of extractDriftIntentIds(body)) {
        if (!this.store.getById(id) && !this.publicStore.getById(id)) {
          trailerOnly.push(sha.slice(0, 8));
          break;
        }
      }
    }
    checks.push({
      name: "trailer-backrefs",
      ok: trailerOnly.length === 0,
      detail: trailerOnly.length
        ? `commits with unresolved Drift-Intent trailers: ${trailerOnly.join(", ")}`
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

  /** Private Drift paths that git does NOT ignore. */
  private untrackPrivateDriftFiles(): string[] {
    const candidates = [
      ".drift/drift.db",
      ".drift/objects",
      ".drift/keys/ed25519.pem",
      ".drift/private",
    ];
    return candidates.filter((p) => {
      const res = execGit(this.repoRoot, ["check-ignore", "-q", "--", p], true);
      return res.status !== 0;
    });
  }

  /** Tracked files under .drift that are NOT in the public allow-list. */
  private trackedPrivateDriftFiles(): string[] {
    const res = execGit(this.repoRoot, ["ls-files", "--", ".drift"], true);
    const allowed = (p: string) =>
      p === ".drift/.gitignore" ||
      p === ".drift/config.toml" ||
      p.startsWith(".drift/public/");
    return res.stdout
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !allowed(p));
  }

  /** Tracked .drift JSON files whose content carries a `prompt` field. */
  private trackedPromptBearingObjects(): string[] {
    return this.trackedPrivateDriftFiles().filter((p) => {
      if (!p.endsWith(".json")) return false;
      const abs = resolve(this.repoRoot, p);
      if (!existsSync(abs)) return false;
      try {
        return /\.json$/.test(p) && JSON.stringify(JSON.parse(readFileSync(abs, "utf8"))).includes("\"prompt\"");
      } catch {
        return false;
      }
    });
  }

  // ---------------------------------------------------------------- export
  exportJson(): string {
    if (this.store) {
      const entries = this.store
        .listIntents({})
        .map((e) => ({
          id: e.id,
          gitSha: e.gitSha,
          authorType: e.authorType,
          authorId: e.authorId,
          model: e.model,
          prompt: this.decryptText(e.prompt, e.id),
          timestamp: new Date(e.timestamp).toISOString(),
          files: e.files,
        }));
      return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), intents: entries }, null, 2);
    }
    // Public-only clone: export the public views (no prompts).
    const entries = this.publicStore.list().map((v) => ({
      id: v.id,
      gitSha: v.commit,
      authorType: v.agent?.type ?? "HUMAN",
      authorId: v.agent?.identifier ?? "unknown",
      model: v.model ?? null,
      summary: v.summary,
      timestamp: new Date(v.timestamp).toISOString(),
      files: (v.files ?? []).map((f) => ({ path: f.path, mutationType: f.mutationType, summary: f.summary ?? null })),
    }));
    return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), intents: entries }, null, 2);
  }

  verifyIntentSignature(intentId: string): { ok: boolean; detail: string } {
    if (this.store) {
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
    // Public-only clone: verify the committed manifest signature.
    const view = this.publicStore.getById(intentId);
    if (!view) return { ok: false, detail: "not found" };
    const valid = this.publicStore.verifySignature(view);
    return { ok: valid, detail: valid ? "valid" : "invalid" };
  }
}

/**
 * Build the git commit message from the (redacted) prompt.
 *
 * `commit-summary` / `none`:
 *   Intent: <first line, truncated to 72 chars>
 *
 *   Model: <model>              (when recorded)
 *   Verification: <verifyCmd>   (when recorded)
 *   Drift-Intent: <id>
 *
 * `full` (legacy): the complete redacted prompt, then the trailer.
 */
function buildCommitMessage(
  safePrompt: string,
  intentId: string,
  opts: { mode: PromptMode; model?: string; verifyCmd?: string },
): string {
  if (opts.mode === "full") {
    return `${safePrompt}\n\nDrift-Intent: ${intentId}`;
  }
  const trailers: string[] = [];
  if (opts.model) trailers.push(`Model: ${opts.model}`);
  if (opts.verifyCmd) trailers.push(`Verification: ${opts.verifyCmd}`);
  trailers.push(`Drift-Intent: ${intentId}`);
  // `none`: the subject must never be derived from the prompt — a one-line
  // prompt would otherwise leak verbatim into git history. Use a generic
  // subject; the trailer carries the machine-readable link.
  if (opts.mode === "none") {
    return `Intent recorded\n\n${trailers.join("\n")}`;
  }
  const firstLine = (safePrompt.split(/\r?\n/)[0] ?? "").trim();
  const summary =
    (firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine) || "intent recorded";
  return `Intent: ${summary}\n\n${trailers.join("\n")}`;
}

function publicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
}

/**
 * ADR-009 ignore rules. Order matters: `*` first, then the negations, so
 * `git add .` inside `.drift/` can only ever stage the public allow-list.
 * Verified with `git check-ignore` / `git add -A` in the storage tests.
 */
const DRIFT_GITIGNORE_RULES = [
  "# Drift private state — never commit",
  "*",
  "!.gitignore",
  "!config.toml",
  "!public/",
  "!public/**",
];

/**
 * Ensure `.drift/.gitignore` contains the ADR-009 rules. Idempotent and
 * non-destructive: existing lines are kept, missing rules are appended as a
 * block (the negation order within the block is preserved).
 */
export function ensureDriftGitignore(driftDir: string): void {
  const path = join(driftDir, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0));
  const missing = DRIFT_GITIGNORE_RULES.filter((l) => !existingLines.has(l));
  if (missing.length === 0) return; // idempotent: nothing to do
  const block = `${existing.trim() ? "\n" : ""}${DRIFT_GITIGNORE_RULES.join("\n")}\n`;
  writeFileSync(path, existing.replace(/[\r\n]+$/, "") + block);
}

/** Map a public manifest to the shared LogEntry shape (no prompt). */
function publicViewToLogEntry(v: PublicIntentView): LogEntry {
  return {
    id: v.id,
    gitSha: v.commit,
    authorType: v.agent?.type ?? "HUMAN",
    authorId: v.agent?.identifier ?? "unknown",
    model: v.model ?? null,
    prompt: "",
    summary: v.summary,
    timestamp: v.timestamp,
    files: (v.files ?? []).map((f) => ({
      path: f.path,
      mutationType: f.mutationType as MutationType,
      summary: f.summary ?? null,
    })),
  };
}

/** Map a public manifest to an IntentRecord-shaped object (private fields empty). */
function publicViewToIntentRecord(v: PublicIntentView): IntentRecord {
  return {
    id: v.id,
    parentId: null,
    gitCommitSha: v.commit,
    author: {
      type: v.agent?.type ?? "HUMAN",
      identifier: v.agent?.identifier ?? "unknown",
      model: v.model ?? undefined,
    },
    prompt: "",
    astDelta: (v.files ?? []).map((f) => ({
      filePath: f.path,
      type: f.mutationType as MutationType,
      nodeIds: [],
      summary: f.summary ?? "",
    })),
    agentState: undefined,
    verifyCmd: v.verification,
    timestamp: v.timestamp,
    objectPath: "",
    signature: v.signature,
  };
}

/** Clamp a user-supplied limit to a safe positive integer (mirrors store.safeLimit). */
function safeClamp(n: number | undefined, fallback: number): number {
  if (n === undefined) return fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

/** Quote a path for shell display in doctor instructions. */
function quotePath(p: string): string {
  return /[^A-Za-z0-9_./-]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p;
}

/**
 * True when `resolved` (absolute) stays inside `root` (absolute). Lexical
 * checks alone would be bypassed by a symlink inside the repo pointing
 * outside, so realpaths are used when the file exists; missing files (e.g.
 * `context` on a deleted-but-recorded path) fall back to the lexical path.
 * The repo root itself is allowed (`rel === ""`).
 */
function isInsideRepo(root: string, resolved: string): boolean {
  let rootReal = root;
  let fileReal = resolved;
  try {
    rootReal = realpathSync(root);
  } catch {
    // keep lexical
  }
  try {
    fileReal = realpathSync(resolved);
  } catch {
    // file may not exist yet — keep lexical
  }
  const rel = relPath(rootReal, fileReal).replace(/\\/g, "/");
  return !isAbsolute(rel) && rel.split("/")[0] !== "..";
}
