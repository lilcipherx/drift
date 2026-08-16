/**
 * The Drift engine: orchestrates every command. Used by the CLI and wrapped
 * by the SDK. The MCP server delegates here through the CLI (PRD §11 contract).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { createPublicKey } from "node:crypto";
import { dirname, isAbsolute, join, relative as relPath, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { computeDelta, detectLanguage, isBinary, parseSymbols, ParseError, textDelta, validateSyntax, } from "@drift/ast";
import { canonicalJson, decryptAesGcm, deriveMasterKey, encryptAesGcm, generateKeyPair, isEncrypted, newIntentId, sha256Hex, signPayload, verifyPayload, } from "./crypto.js";
import { CONFIG_TEMPLATE, loadConfig } from "./config.js";
import { DriftError, EXIT, NotInitializedError } from "./errors.js";
import { blameLine, blameLines, captureIndexSnapshot, checkout, commit, commitExists, currentHead, discardIndexSnapshot, execGit, findRepoRoot, gitIdentity, gitLogMessages, readFileAt, restoreIndexSnapshot, stageAll, stagedNameStatus, } from "./git.js";
import { IntentStore } from "./store.js";
import { compilePatterns, redact } from "./redact.js";
import { buildPublicSummary, genericPublicSummary, PUBLIC_FILES_MAX, PublicStore, signingKeyIdFor, } from "./public.js";
import { extractDriftIntentIds } from "./trailers.js";
/** Default timeout for a `drift verify --run` verification command (ms). */
const VERIFY_TIMEOUT_MS = 120_000;
/**
 * Environment allowlist for `drift verify --run`. Repository-provided
 * verification commands are UNTRUSTED code: by default the child process gets
 * only the non-secret variables needed for ordinary PATH-based tooling on
 * Linux/macOS/Windows (git, npm, node, shell). Secret-bearing variables
 * (GITHUB_TOKEN, GH_TOKEN, NPM_TOKEN, NODE_AUTH_TOKEN, DRIFT_MASTER_KEY,
 * AWS_*, AZURE_*, GOOGLE_*, GCP_*, SSH_AUTH_SOCK, DATABASE_URL, anything
 * named *_TOKEN / *_SECRET / *PRIVATE_KEY*) are deliberately absent. Full
 * inheritance requires an explicit `--inherit-env` opt-in.
 */
export const VERIFY_ENV_ALLOWLIST = [
    // PATH resolution + home for config lookups
    "PATH",
    "HOME",
    "USERPROFILE",
    // temp dirs (build tools, npm, git)
    "TMPDIR",
    "TMP",
    "TEMP",
    // Windows runtime essentials
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "OS",
    // locale — affects encoding of command output
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    // non-secret CI signals
    "CI",
    "GITHUB_ACTIONS",
    // interactive shell basics
    "SHELL",
    "TERM",
    "TERM_PROGRAM",
    "USER",
    "LOGNAME",
    "HOSTNAME",
    "PWD",
];
/** Build the sanitized child environment from a parent env (default: process). */
export function sanitizedVerifyEnv(parent = process.env) {
    const out = {};
    for (const key of VERIFY_ENV_ALLOWLIST) {
        const value = parent[key];
        if (value === undefined)
            continue;
        // Belt-and-suspenders: even a future allowlist addition can never leak a
        // variable that looks like a credential.
        if (SECRET_ENV_PATTERNS.some((re) => re.test(key)))
            continue;
        out[key] = value;
    }
    return out;
}
/** Variables that must NEVER reach an untrusted verification child by default. */
const SECRET_ENV_PATTERNS = [
    /^GITHUB_TOKEN$/i,
    /^GH_TOKEN$/i,
    /^NPM_TOKEN$/i,
    /^NODE_AUTH_TOKEN$/i,
    /^DRIFT_MASTER_KEY$/i,
    /^AWS_/,
    /^AZURE_/,
    /^GOOGLE_/,
    /^GCP_/,
    /^SSH_AUTH_SOCK$/i,
    /^DATABASE_URL$/i,
    /TOKEN/i,
    /SECRET/i,
    /PRIVATE_KEY/i,
];
export class Drift {
    repoRoot;
    driftDir;
    config;
    /**
     * Private SQLite intent store. `null` in public-only mode (fresh clone,
     * ADR-009): read commands then serve from the committed public manifests.
     */
    store;
    publicStore;
    privateKeyPem = "";
    publicKeyPem = "";
    signerState = "missing";
    redactionPatterns;
    publicOnly;
    /**
     * @param opts.forceStore open the private store even when drift.db is
     *   absent (used by `init`, which creates it).
     */
    constructor(repoRoot, opts = {}) {
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
            this.signerState = this.publicKeyPem ? "read-only" : "missing";
        }
        else {
            try {
                this.store = IntentStore.open(dbPath);
            }
            catch (err) {
                // A corrupted SQLite file surfaces as an opaque driver error; report it
                // as a corrupt DAG (PRD §14.1 exit 5) instead of a generic error 1.
                throw new DriftError(`Drift database is corrupt or unreadable (${this.driftDir}/drift.db): ${err instanceof Error ? err.message : String(err)}. Restore it from a backup or run \`git clean -fdx .drift\` + \`drift init\` to start fresh.`, EXIT.CORRUPT);
            }
            this.deriveKeyState();
        }
    }
    /**
     * Resolve the signer state from the private key (if present) and the
     * committed public trust root. Never throws for a missing or mismatched
     * private key — read commands must keep working; only signing is refused.
     *
     * State A: neither key            → missing (init generates a pair).
     * State B: both, matching         → ready.
     * State C: public only            → read-only (fresh clone).
     * State D: private only           → derive public, ready.
     * State E: both, not matching     → mismatch (signing refused).
     */
    deriveKeyState() {
        const committedPub = this.publicStore.publicKey();
        const keyPath = join(this.driftDir, "keys", "ed25519.pem");
        if (!existsSync(keyPath)) {
            this.privateKeyPem = "";
            this.publicKeyPem = committedPub ?? "";
            this.signerState = committedPub ? "read-only" : "missing";
            return;
        }
        const privateKeyPem = readFileSync(keyPath, "utf8");
        let derived;
        try {
            derived = publicKeyFromPrivate(privateKeyPem).trim();
        }
        catch {
            throw new DriftError(`The Drift signing key (${keyPath}) is unreadable or corrupt. Restore it or import the repository key with \`drift key import --file <path>\`.`, EXIT.KEY);
        }
        if (committedPub && derived !== committedPub) {
            // State E: do not sign with a key that is not the trust root, and never
            // overwrite either key automatically.
            this.privateKeyPem = "";
            this.publicKeyPem = committedPub;
            this.signerState = "mismatch";
            return;
        }
        this.privateKeyPem = privateKeyPem;
        this.publicKeyPem = derived;
        this.signerState = "ready";
    }
    // ---------------------------------------------------------- encryption
    /** DRIFT_MASTER_KEY → 32-byte AES key, or null when not set (PRD §17.2). */
    getMasterKey() {
        const secret = process.env.DRIFT_MASTER_KEY;
        return secret ? deriveMasterKey(secret) : null;
    }
    /** Throw E_KEY (exit 4) when encryption is enabled but the key is missing. */
    masterKeyOrThrow() {
        const key = this.getMasterKey();
        if (!key) {
            throw new DriftError("Encryption is enabled in .drift/config.toml but DRIFT_MASTER_KEY is not set. Set the environment variable or disable encryption.", EXIT.KEY);
        }
        return key;
    }
    /**
     * Decrypt a stored value when it is an encrypted payload (AAD-bound to the
     * intent id). Legacy plaintext passes through untouched. Without a key:
     * readable fields degrade to a placeholder; `replay`/`verify` fail hard
     * with E_KEY instead.
     */
    decryptText(value, aad) {
        if (!isEncrypted(value))
            return value; // legacy plaintext (v0.1.0)
        const key = this.getMasterKey();
        if (!key)
            return "[encrypted]";
        try {
            return decryptAesGcm(value, key, aad);
        }
        catch {
            return "[encrypted:invalid-key-or-corrupt]";
        }
    }
    // ------------------------------------------------------------------ setup
    static fromCwd(cwd) {
        const root = findRepoRoot(cwd, process.env.DRIFT_REPO);
        if (!root)
            throw new DriftError("Not inside a git repository");
        const driftDir = join(root, ".drift");
        if (!existsSync(driftDir))
            throw new NotInitializedError();
        return new Drift(root);
    }
    static init(cwd, opts = {}) {
        const root = findRepoRoot(cwd, process.env.DRIFT_REPO);
        if (!root)
            throw new DriftError("Not inside a git repository");
        const driftDir = join(root, ".drift");
        const firstTime = !existsSync(driftDir);
        // Always (re)create the directories: `drift init` must also work on a
        // fresh clone where `.drift/` exists (public provenance) but the local
        // store, objects and keys do not (ADR-009). mkdir recursive is a no-op
        // when they already exist. The config template is only written on first
        // setup so a user-edited config.toml is never overwritten.
        mkdirSync(driftDir, { recursive: true });
        mkdirSync(join(driftDir, "objects"), { recursive: true });
        mkdirSync(join(driftDir, "keys"), { recursive: true });
        mkdirSync(join(driftDir, "public", "intents"), { recursive: true });
        if (firstTime) {
            writeFileSync(join(driftDir, "config.toml"), CONFIG_TEMPLATE);
        }
        // Idempotent merge: never deletes user lines, only ensures the ADR-009
        // ignore rules are present so `git add .` can never stage private data.
        ensureDriftGitignore(driftDir);
        // --- key-state resolution (never replaces an existing trust root) ------
        // The committed `.drift/public/key.pem` is the repository trust root. It
        // must be preserved byte-for-byte in a fresh clone (State C) and never
        // silently replaced. Only genuinely new repositories (State A) generate a
        // keypair; a private-only checkout (State D) derives the public key; a
        // mismatch (State E) fails safely.
        const keyPath = join(driftDir, "keys", "ed25519.pem");
        const committedPub = new PublicStore(driftDir).publicKey();
        const privateExists = existsSync(keyPath);
        let publicKeyPem;
        let signerState;
        if (committedPub && privateExists) {
            const privateKeyPem = readFileSync(keyPath, "utf8");
            const derived = publicKeyFromPrivate(privateKeyPem).trim();
            if (derived !== committedPub) {
                throw new DriftError("Signing-key mismatch detected: .drift/keys/ed25519.pem does not match the committed trust root (.drift/public/key.pem).\nNothing was overwritten. Import the correct repository key with:\n  drift key import --file /secure/path/repository-private-key.pem", EXIT.KEY);
            }
            publicKeyPem = committedPub;
            signerState = "ready"; // State B
        }
        else if (committedPub && !privateExists) {
            // State C — fresh clone: preserve the trust root, enter read-only
            // signer mode. No keypair is generated, the public key is untouched.
            publicKeyPem = committedPub;
            signerState = "read-only";
        }
        else if (!committedPub && privateExists) {
            // State D — private key exists but the public key was lost: derive it.
            const privateKeyPem = readFileSync(keyPath, "utf8");
            publicKeyPem = publicKeyFromPrivate(privateKeyPem).trim();
            new PublicStore(driftDir).writePublicKey(publicKeyPem);
            signerState = "ready";
        }
        else {
            // State A — genuinely new repository: generate one keypair.
            const keyPair = generateKeyPair();
            publicKeyPem = keyPair.publicKeyPem.trim();
            writeFileSync(keyPath, keyPair.privateKeyPem, { mode: 0o600 });
            new PublicStore(driftDir).writePublicKey(publicKeyPem);
            signerState = "ready";
        }
        const drift = new Drift(root, { forceStore: true });
        const store = drift.requireStore("drift init");
        store.setMeta("schema_version", "1");
        store.setMeta("public_key", publicKeyPem);
        store.setMeta("signer_state", signerState);
        store.setMeta("created_at", String(Date.now()));
        if (opts.author)
            store.setMeta("default_author", opts.author);
        drift.close();
        return {
            repoRoot: root,
            driftDir,
            publicKeyPem,
            signerState,
            publicKeyFingerprint: signingKeyIdFor(publicKeyPem),
        };
    }
    /**
     * Import the repository private signing key (ADR-009 key model, State C →
     * ready). Validates the key, derives its public key, requires it to match
     * the committed trust root, copies it atomically with restrictive
     * permissions, and never prints key material or stages it in git.
     */
    keyImport(privateKeyFilePath) {
        const committedPub = this.publicStore.publicKey();
        if (!committedPub) {
            throw new DriftError("No committed public trust root (.drift/public/key.pem) in this repository. Run `drift init` in a new repository first — there is nothing for this key to match.", EXIT.KEY);
        }
        const pem = readFileSync(resolve(privateKeyFilePath), "utf8");
        let derived;
        try {
            derived = publicKeyFromPrivate(pem).trim();
        }
        catch {
            throw new DriftError(`The file at ${privateKeyFilePath} is not a readable Ed25519 private key.`, EXIT.KEY);
        }
        if (derived !== committedPub) {
            throw new DriftError("The private key does not match the committed trust root (.drift/public/key.pem). Refusing to import — nothing was written.", EXIT.KEY);
        }
        const keysDir = join(this.driftDir, "keys");
        mkdirSync(keysDir, { recursive: true });
        const target = join(keysDir, "ed25519.pem");
        const tmp = `${target}.tmp-${process.pid}`;
        writeFileSync(tmp, pem, { mode: 0o600 });
        renameSync(tmp, target);
        return { signerState: "ready", publicKeyFingerprint: signingKeyIdFor(committedPub) };
    }
    /**
     * Refuse to create NEW signed provenance unless the local private key
     * matches the committed trust root (States A/B/D). Read-only clones (C) and
     * mismatches (E) get an actionable message and exit E_KEY.
     */
    assertSignerReady(command) {
        if (this.signerState === "ready")
            return;
        if (this.signerState === "read-only") {
            throw new DriftError(`Public provenance exists, but the matching private signing key is unavailable (\`${command}\` needs it).\n\nRead operations remain available.\nImport the repository signing key before creating new signed intents:\n  drift key import --file /secure/path/repository-private-key.pem`, EXIT.KEY);
        }
        if (this.signerState === "mismatch") {
            throw new DriftError("Signing-key mismatch detected: .drift/keys/ed25519.pem does not match the committed trust root (.drift/public/key.pem).\nImport the correct key with `drift key import --file <path>` — nothing was overwritten.", EXIT.KEY);
        }
        throw new DriftError(`No Drift signing key in this checkout — run \`drift init\` first.`, EXIT.KEY);
    }
    close() {
        this.store?.close();
    }
    /** The private store, or a clear error naming the command that needs it. */
    requireStore(command) {
        if (!this.store) {
            throw new DriftError(`No local Drift store in this clone — \`${command}\` needs private local data. Run \`drift init\` to create the local intent store and signing key.`, EXIT.KEY);
        }
        return this.store;
    }
    get publicKey() {
        return this.publicKeyPem;
    }
    // ---------------------------------------------------------------- status
    /**
     * First-run friendly status: always succeeds as a read, reports whether the
     * repo is initialized and what the next step is. Never throws for missing
     * init (a corrupted store still surfaces as exit 5).
     */
    static status(cwd) {
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
            // Committed public manifests are canonical (ADR-009): an empty local
            // store (e.g. right after `drift init` in a fresh clone) must never
            // shadow them, so `intents` is the MERGED count, with the public and
            // local-only parts reported separately.
            const { errors: manifestErrors } = drift.publicStore.listWithErrors();
            const publicIntents = drift.publicStore.list().length;
            const localIntents = drift.store ? drift.store.allRows().length : 0;
            const publicProvenance = drift.publicStore.exists();
            return {
                initialized: true,
                repoRoot: root,
                intents: drift.log({}).length,
                publicIntents,
                localIntents,
                malformedManifests: manifestErrors.length > 0 ? manifestErrors : undefined,
                head: drift.store?.getHead() ?? null,
                encryption: drift.config.encryption.enabled,
                promptMode: drift.config.prompts.mode,
                gitBranch: branchRes.status === 0 ? branchRes.stdout.trim() : null,
                gitHead: headRes.status === 0 ? headRes.stdout.trim() : null,
                gitDirty: ws.stdout.trim().length > 0,
                lastIntent: last
                    ? { id: last.id, timestamp: last.timestamp, summary: last.summary ?? "" }
                    : null,
                signerState: drift.signerState,
                publicKeyFingerprint: drift.publicKeyPem ? signingKeyIdFor(drift.publicKeyPem) : null,
                privateKeyAvailable: drift.privateKeyPem !== "",
                signingAllowed: drift.signerState === "ready",
                publicProvenance,
                verificationMaterial: drift.publicStore.publicKey() !== null,
            };
        }
        finally {
            drift.close();
        }
    }
    // ---------------------------------------------------------------- realize
    realize(opts) {
        const store = this.requireStore("drift realize");
        // A fresh clone or a mismatched local key must not create NEW signed
        // provenance with the wrong/absent key (ADR-009 key model, States C/E).
        this.assertSignerReady("drift realize");
        const prompt = (opts.prompt ?? "").trim();
        if (!prompt) {
            throw new DriftError("realize requires a prompt: drift realize -p \"what did you change and why\"");
        }
        // Capture the user's staged state BEFORE Drift stages anything, so a
        // syntax/analysis failure can restore the index exactly (staged files,
        // partially staged hunks, intent-to-add entries, renames, deletions,
        // assume-unchanged/skip-worktree flags). Never a broad `git reset` that
        // discards the user's selections. Refuse to run against an unmerged index
        // (a conflict in progress) before any write happens.
        const unmerged = execGit(this.repoRoot, ["ls-files", "-u"], true);
        if (unmerged.status === 0 && unmerged.stdout.trim().length > 0) {
            throw new DriftError("the git index has unmerged (conflict) entries — resolve the merge conflict and run drift realize again");
        }
        const indexSnapshot = captureIndexSnapshot(this.repoRoot);
        let manifestPath = null;
        // Every operation after the snapshot is inside the protected scope below:
        // staging, no-staged-files validation, staged-file listing, AST analysis,
        // syntax parsing, redaction, private-object writing, manifest
        // construction, signing, manifest writing, public-file staging and the
        // git commit. Any failure while `phase` is "building" (before the commit
        // lands) restores the user's index byte-for-byte; once the commit lands
        // ("committing"/"recorded") the index is left as-is and the snapshot is
        // discarded.
        let phase = "building";
        try {
            stageAll(this.repoRoot, opts.files);
            const staged = stagedNameStatus(this.repoRoot);
            if (staged.length === 0) {
                throw new DriftError("No changes to realize. Edit (or stage) a file first.", EXIT.NO_CHANGES);
            }
            const head = currentHead(this.repoRoot);
            const deltas = [];
            const syntaxErrors = [];
            for (const { status, path } of staged) {
                // Deleted files have no working-tree content; record a DELETED delta.
                if (status === "D") {
                    const pre = head ? readFileAt(this.repoRoot, path, head) : null;
                    deltas.push(...textDelta(path, pre, null).changes);
                    continue;
                }
                let post;
                try {
                    post = readFileSync(resolve(this.repoRoot, path));
                }
                catch {
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
                    const preSyms = pre === null ? null : parseSymbols(pre, lang);
                    const postSyms = parseSymbols(postText, lang);
                    deltas.push(...computeDelta(path, preSyms, postSyms).changes);
                }
                catch (err) {
                    if (err instanceof ParseError) {
                        syntaxErrors.push({ file: path, message: err.message });
                    }
                    else {
                        throw err;
                    }
                }
            }
            if (syntaxErrors.length > 0) {
                // Thrown inside the protected scope: the catch below restores the user's
                // exact pre-Drift index state — never `git reset` wholesale, which
                // would discard their staged selections.
                throw new DriftError(`Syntax error — commit aborted, no history was polluted (your staged changes were preserved):\n  - ${syntaxErrors
                    .map((e) => `${e.file}: ${e.message}`)
                    .join("\n  - ")}\nFix the code and run realize again.`, EXIT.SYNTAX);
            }
            // Any failure BEFORE the git commit (redaction, store access, signing,
            // manifest write, staging public files) must restore the user's index
            // exactly and remove only the manifest this operation generated — never
            // the user's source selections. Once the commit lands (phase
            // "committing"/"recorded") the index restore is NOT performed: the source
            // changes stay staged for a safe retry and a landed commit is never
            // rewritten.
            const redactionResult = redact(prompt, this.redactionPatterns);
            const safePrompt = redactionResult.text;
            const safeState = opts.agentState
                ? redact(opts.agentState, this.redactionPatterns).text
                : undefined;
            const headId = store.getHead();
            const timestamp = Date.now();
            const id = newIntentId();
            const authorId = opts.author ?? (gitIdentity(this.repoRoot, "user.name") || "unknown");
            const author = {
                type: (opts.authorType ?? (opts.model ? "AGENT" : "HUMAN")),
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
            // The PUBLIC summary is deliberately NOT derived from the prompt (ADR-009):
            // the first line of a one-line prompt would otherwise be copied verbatim
            // into git history, manifests and PR comments. It comes from an explicit
            // `--summary` (redacted first, so secrets can't ride along) or a generic
            // non-prompt fallback built from the intent id.
            const mode = this.config.prompts.mode;
            const explicitSummary = opts.summary
                ? buildPublicSummary(redact(opts.summary, this.redactionPatterns).text)
                : "";
            // The public summary is NEVER empty: without an explicit `--summary` a
            // generic non-prompt fallback is used even under `prompts.mode = "none"`
            // ("none" means "do not persist the raw prompt" — it does not require an
            // empty public provenance record). The manifest validator rejects empty
            // summaries, so this also guarantees every written manifest is renderable.
            const publicSummary = explicitSummary || genericPublicSummary(id, { fileCount: deltas.length });
            const storePrompt = mode !== "none";
            const storedPrompt = storePrompt
                ? encKey
                    ? encryptAesGcm(safePrompt, encKey, id)
                    : safePrompt
                : "";
            const storedState = encKey && safeState !== undefined ? encryptAesGcm(safeState, encKey, id) : safeState;
            const commitMessage = buildCommitMessage({
                safePrompt,
                summary: publicSummary,
                intentId: id,
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
            const objectPath = join(".drift", "objects", objectSha.slice(0, 2), `${objectSha.slice(2)}.json`);
            const absObjectPath = join(this.repoRoot, objectPath);
            mkdirSync(dirname(absObjectPath), { recursive: true });
            const objectData = JSON.stringify({ ...intentBase, gitCommitSha: "", signature }, null, 2);
            const tmpPath = `${absObjectPath}.tmp-${process.pid}`;
            writeFileSync(tmpPath, objectData);
            renameSync(tmpPath, absObjectPath);
            // --- ADR-009 atomic transaction ---------------------------------------
            // Order is critical (docs/architecture.md "Realize transaction"):
            //   1. build the V2 public manifest (NEVER contains the containing commit
            //      SHA — that would be a self-referential cycle);
            //   2. write + sign it on disk;
            //   3. explicitly stage ONLY the approved public paths;
            //   4. create ONE git commit containing source + public provenance;
            //   5. record the resulting SHA only in the local private database.
            // The commit's `Drift-Intent:` trailer is the canonical intent→commit
            // association for every consumer (log/blame/status/export/Action/App).
            const publicView = {
                schemaVersion: 2,
                id,
                summary: publicSummary,
                model: opts.model,
                agent: { type: author.type, identifier: author.identifier },
                verification: opts.verifyCmd,
                files: deltas
                    .slice(0, PUBLIC_FILES_MAX)
                    .map((d) => ({ path: d.filePath, mutationType: d.type, summary: d.summary || undefined })),
                timestamp,
                signingKeyId: signingKeyIdFor(this.publicKeyPem),
            };
            // Write + sign the manifest BEFORE the git commit so the same commit that
            // carries the source change also carries its provenance (no second manual
            // `git add . && git commit` needed). The signature covers the V2 payload
            // which has no commit SHA, so the manifest is stable once committed.
            manifestPath = this.publicStore.manifestPath(id);
            this.publicStore.write(publicView, this.privateKeyPem);
            // Stage ONLY the approved public paths — never .drift/private, objects,
            // keys or drift.db. Staging uses explicit argument arrays, never shell
            // interpolation.
            const stagedPublic = this.stagePublicFiles(id);
            phase = "committing";
            let gitSha;
            try {
                gitSha = commit(this.repoRoot, commitMessage);
            }
            catch (err) {
                // Commit failed: unstage + remove ONLY the manifest this operation just
                // generated (and only if we staged it). The user's source changes stay
                // staged; the private object record is preserved for a safe retry.
                execGit(this.repoRoot, ["reset", "-q", "--", relPath(this.repoRoot, manifestPath).replace(/\\/g, "/")], true);
                try {
                    rmSync(manifestPath, { force: true });
                }
                catch {
                    /* best-effort */
                }
                throw new DriftError(`git commit failed — no history was created: ${err instanceof Error ? err.message : String(err)}. Your source changes are still staged; run \`drift realize\` again after fixing the problem.`);
            }
            phase = "recorded";
            const intent = {
                ...intentBase,
                gitCommitSha: gitSha,
                objectPath: objectPath.replace(/\\/g, "/"),
                signature,
            };
            try {
                store.insertIntent(intent);
            }
            catch (err) {
                // Commit landed but intent recording failed — surface it so the user can
                // run `drift doctor` (trailer-backref check) instead of a bare error.
                throw new DriftError(`git commit landed (${gitSha}) but intent recording failed: ${err instanceof Error ? err.message : String(err)}. Public provenance was committed; run \`drift doctor\` to reindex the local store.`);
            }
            store.setHead(id);
            void stagedPublic; // staged paths are intentionally not returned
            return { gitSha, intentId: id, astDelta: deltas, redactions: redactionResult.count };
        }
        catch (err) {
            // Only failures BEFORE the commit restore the index. Once the commit
            // landed, the source changes must stay staged and the commit is never
            // rewritten (the commit/insert failure paths above already handled
            // their own cleanup).
            if (phase === "building") {
                try {
                    restoreIndexSnapshot(this.repoRoot, indexSnapshot);
                }
                catch (restoreErr) {
                    // A failed restore must produce an actionable diagnostic — the
                    // original failure is preserved and the index lock is surfaced so
                    // the user can resolve it before retrying.
                    throw new DriftError(`realize aborted before committing AND the git index could not be restored: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}. ` +
                        `Original failure: ${err instanceof Error ? err.message : String(err)}. ` +
                        `Run \`git status\` and resolve the index lock first; Drift's staging may not have been rolled back.`);
                }
                if (manifestPath) {
                    try {
                        rmSync(manifestPath, { force: true });
                    }
                    catch {
                        /* best-effort */
                    }
                }
                throw err instanceof DriftError
                    ? err
                    : new DriftError(`realize aborted before committing — your staged changes were preserved: ${err instanceof Error ? err.message : String(err)}`);
            }
            throw err;
        }
        finally {
            // A successful commit discards the snapshot (no restore); a pre-commit
            // failure already restored it (restore removes the backup dir). Either
            // way no `drift-idx-*` backup may survive — including on a persistent
            // self-hosted runner across many realizations.
            discardIndexSnapshot(this.repoRoot, indexSnapshot);
        }
    }
    /**
     * Stage ONLY approved public Drift paths for the realize commit. The
     * ADR-009 trust boundary is staged on genuine first introduction only:
     *
     *   - `.drift/.gitignore`        — staged when new or unchanged vs HEAD;
     *                                  a user's unexpected working-tree edit is
     *                                  left alone (never silently committed).
     *   - `.drift/public/key.pem`    — staged on first introduction; if the key
     *                                  is ALREADY tracked and its working-tree
     *                                  content differs from HEAD, signing is
     *                                  REFUSED instead of staging a trust-root
     *                                  replacement the user did not approve.
     *   - manifest                    — always staged (written by this operation).
     *   - `.drift/config.toml`       — staged ONLY when byte-identical to the
     *                                  safe public template (first
     *                                  introduction). Never staged merely
     *                                  because it is tracked: that could carry
     *                                  an unstaged user edit into the commit.
     *                                  A config the user already staged rides
     *                                  along in the whole-index commit.
     */
    stagePublicFiles(intentId) {
        const configAbs = join(this.driftDir, "config.toml");
        const configIsUntouchedTemplate = existsSync(configAbs) && readFileSync(configAbs, "utf8") === CONFIG_TEMPLATE;
        const rel = (abs) => relPath(this.repoRoot, abs).replace(/\\/g, "/");
        const tracked = (abs) => execGit(this.repoRoot, ["ls-files", "--error-unmatch", "--", rel(abs)], true).status === 0;
        const changedVsHead = (abs) => execGit(this.repoRoot, ["diff", "--quiet", "HEAD", "--", rel(abs)], true).status !== 0;
        const keyAbs = this.publicStore.keyPath;
        // A tracked trust-root file with unexpected working-tree changes must
        // never be silently staged: that would swap the repository's trust root
        // without an explicit rotation.
        if (tracked(keyAbs) && changedVsHead(keyAbs)) {
            throw new DriftError(`.drift/public/key.pem is tracked but its working-tree content differs from HEAD — refusing to stage an unapproved trust-root change. Revert or commit the key change deliberately before running drift realize.`);
        }
        const gitignoreAbs = join(this.driftDir, ".gitignore");
        const candidates = [
            { abs: gitignoreAbs, always: true }, // staged when new or unchanged (see filter below)
            { abs: keyAbs, always: true },
            { abs: this.publicStore.manifestPath(intentId), always: true },
            { abs: configAbs, always: configIsUntouchedTemplate },
        ];
        const toStage = candidates
            .filter((c) => {
            if (!existsSync(c.abs))
                return false;
            if (c.abs === configAbs)
                return c.always; // only the untouched template
            if (c.abs === gitignoreAbs) {
                // Stage the gitignore on first introduction; leave an unexpected
                // user edit (tracked + changed) alone.
                return !tracked(c.abs) || !changedVsHead(c.abs);
            }
            // key and manifest: key already passed the tracked+changed refusal;
            // the manifest was just written by this operation.
            return true;
        })
            .map((c) => rel(c.abs));
        if (toStage.length > 0)
            execGit(this.repoRoot, ["add", "--", ...toStage]);
        return toStage;
    }
    // -------------------------------------------------------------------- log
    log(filters = {}) {
        let entries = this.mergeIntents();
        if (filters.author)
            entries = entries.filter((e) => e.authorId === filters.author);
        if (filters.model)
            entries = entries.filter((e) => e.model === filters.model);
        if (filters.file) {
            // prefix semantics mirror the store's SQL LIKE (e.g. `--file src/auth`
            // matches src/auth.ts)
            entries = entries.filter((e) => e.files.some((f) => f.path.startsWith(filters.file)));
        }
        entries.sort((a, b) => b.timestamp - a.timestamp);
        const limit = filters.limit !== undefined ? safeClamp(filters.limit, 100) : 100;
        return entries.slice(0, limit);
    }
    /**
     * Tracked manifests that fail strict schema validation. Consumers render
     * only valid manifests; this surfaces the rest as an actionable diagnostic
     * (never a crash, never a silent "valid").
     */
    publicManifestDiagnostics() {
        return this.publicStore.listWithErrors().errors;
    }
    /**
     * Canonical provenance is the committed public manifest (ADR-009) — that is
     * what survives a fresh clone and what the Action/App consume. The private
     * store only enriches those entries with the local prompt; store-only
     * (legacy pre-ADR-009) intents are kept so old repos keep working.
     */
    /**
     * Canonical intent → commit association, derived ONLY from `Drift-Intent:`
     * git trailers (never from an unverified manifest field). `byId` maps each
     * intent id to the FIRST commit that references it (newest-first log order,
     * i.e. the introducing commit). `byCommit` maps each commit to all ids its
     * message references. Used by log, context, blame, status, export and the
     * fresh-clone paths so every consumer shares one resolver.
     */
    intentCommitIndex() {
        const byId = new Map();
        const byCommit = new Map();
        for (const { sha, body } of gitLogMessages(this.repoRoot)) {
            const ids = extractDriftIntentIds(body);
            if (ids.length === 0)
                continue;
            byCommit.set(sha, ids);
            for (const id of ids) {
                if (!byId.has(id))
                    byId.set(id, sha);
            }
        }
        return { byId, byCommit };
    }
    /**
     * Public manifests referenced by a commit's `Drift-Intent:` trailers. Falls
     * back to the V1 embedded `commit` field only when no trailer-derived match
     * exists (legacy manifests written before trailers became canonical).
     */
    findManifestsForCommit(sha) {
        const res = execGit(this.repoRoot, ["log", "-1", "--format=%B", sha], true);
        if (res.status === 0) {
            const ids = extractDriftIntentIds(res.stdout);
            if (ids.length > 0) {
                return ids
                    .map((id) => this.publicStore.getById(id))
                    .filter((v) => v !== null);
            }
        }
        return this.publicStore.list().filter((v) => v.schemaVersion === 1 && v.commit === sha);
    }
    /**
     * Canonical provenance is the committed public manifest (ADR-009) — that is
     * what survives a fresh clone and what the Action/App consume. The private
     * store only enriches those entries with the local prompt; store-only
     * (legacy pre-ADR-009) intents are kept so old repos keep working.
     */
    mergeIntents() {
        const byId = new Map();
        const { byId: commitById } = this.intentCommitIndex();
        for (const view of this.publicStore.list()) {
            if (byId.has(view.id))
                continue;
            const gitSha = commitById.get(view.id) ??
                (view.schemaVersion === 1 ? view.commit : null) ??
                "";
            byId.set(view.id, publicViewToLogEntry(view, gitSha));
        }
        if (this.store) {
            for (const e of this.store.listIntents({})) {
                const existing = byId.get(e.id);
                if (existing) {
                    existing.prompt = this.decryptText(e.prompt, e.id);
                    existing.summary = existing.summary || this.summaryFor(e.id, existing.prompt);
                }
                else {
                    const prompt = this.decryptText(e.prompt, e.id);
                    byId.set(e.id, { ...e, prompt, summary: this.summaryFor(e.id, prompt) });
                }
            }
        }
        return [...byId.values()];
    }
    /**
     * Safe public summary for an intent: committed manifest first; for legacy
     * pre-ADR-009 records without a manifest, a generic non-prompt fallback
     * (never prompt text — public summaries cannot be reconstructed safely).
     */
    summaryFor(id, _localPrompt) {
        const view = this.publicStore.getById(id);
        if (view)
            return view.summary;
        return genericPublicSummary(id);
    }
    // ------------------------------------------------------------------ blame
    blame(filePath, opts = {}) {
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
        let functionName;
        let functionEndLine;
        if (opts.functionName) {
            const source = readFileSync(file, "utf8");
            const lang = detectLanguage(relative);
            if (!lang)
                throw new DriftError(`Unsupported language: ${relative}`);
            const symbols = parseSymbols(source, lang);
            const symbol = symbols.find((s) => s.name === opts.functionName);
            if (!symbol) {
                throw new DriftError(`Function "${opts.functionName}" not found in ${relative}`);
            }
            line = symbol.startLine;
            functionEndLine = symbol.endLine;
            functionName = opts.functionName;
        }
        if (!line)
            throw new DriftError("blame requires --line N or --function NAME");
        const totalLines = readFileSync(file, "utf8").split("\n").length;
        if (line < 1 || line > totalLines) {
            throw new DriftError(`Line ${line} is out of range (1..${totalLines})`);
        }
        // One shared trailer-derived resolver (ADR-009 V2): intent commits are
        // found by their `Drift-Intent:` trailer, not by any embedded manifest
        // field. Built once per blame call.
        const { byCommit: commitIndex } = this.intentCommitIndex();
        const isIntentCommit = (s) => this.store?.findByGitSha(s) !== null || commitIndex.has(s) || this.publicStore.findByCommit(s) !== null;
        let sha;
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
                if (!s)
                    continue;
                if (!fallback) {
                    fallback = s;
                    fallbackLine = ln;
                }
                if (isIntentCommit(s)) {
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
            if (!chosen && fallbackLine)
                line = fallbackLine;
        }
        else {
            sha = blameLine(this.repoRoot, relative, line);
            if (!sha) {
                throw new DriftError(`Could not blame ${relative}:${line}`);
            }
        }
        const committed = sha !== "0000000000000000000000000000000000000000";
        let intent = null;
        if (committed) {
            let record = null;
            let signatureValid = false;
            // Canonical provenance is the committed public manifest (ADR-009) — it
            // verifies against the COMMITTED public key, so a fresh clone or a
            // regenerated local key can never make a real signature look valid
            // (or invalid) by accident. The private store is only a legacy fallback
            // for pre-ADR-009 intents that have no manifest yet. The commit→intent
            // association comes from git trailers via the shared resolver.
            const view = this.findManifestsForCommit(sha)[0] ?? null;
            const localRecord = this.store?.findByGitSha(sha) ?? null;
            if (view) {
                record = publicViewToIntentRecord(view, sha);
                signatureValid = this.publicStore.verifySignature(view);
                // Enrich with the LOCAL private prompt/state when present (surfaced
                // only through the CLI's explicit --include-private-prompt flag).
                if (localRecord) {
                    record.prompt = localRecord.prompt;
                    record.agentState = localRecord.agentState;
                    record.objectPath = localRecord.objectPath;
                    record.signature = localRecord.signature;
                }
            }
            else if (localRecord) {
                record = localRecord;
                if (this.store) {
                    const obj = this.store.readObjectRecord(record.objectPath);
                    const canonical = obj
                        ? canonicalJson({
                            id: obj.id ?? record.id,
                            parentId: obj.parentId ?? record.parentId,
                            author: obj.author ?? record.author,
                            prompt: obj.prompt ?? record.prompt,
                            astDelta: obj.astDelta ?? record.astDelta,
                            agentState: obj.agentState ?? record.agentState,
                            verifyCmd: obj.verifyCmd ?? record.verifyCmd,
                            timestamp: obj.timestamp ?? record.timestamp,
                        })
                        : "";
                    const signature = obj?.signature ?? record.signature;
                    signatureValid = signature ? verifyPayload(canonical, this.publicKeyPem, signature) : false;
                }
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
    context(filePath, limit = 5) {
        // Same containment rule as blame: file arguments are repo-relative, and
        // normalising here also makes `./src/a.ts` and absolute in-repo paths
        // match the stored repo-relative intent paths.
        const file = resolve(this.repoRoot, filePath);
        const relative = relPath(this.repoRoot, file).replace(/\\/g, "/");
        if (!isInsideRepo(this.repoRoot, file)) {
            throw new DriftError(`Path escapes the repository root: ${filePath}`);
        }
        const entries = this.mergeIntents().filter((e) => e.files.some((f) => f.path === relative));
        entries.sort((a, b) => b.timestamp - a.timestamp);
        return entries.slice(0, safeClamp(limit, 5));
    }
    // ---------------------------------------------------------------- verify
    /**
     * Verification is INFORMATION by default: `drift verify <id>` validates the
     * manifest schema, reports the signature/trust state and shows the recorded
     * command WITHOUT executing it. A repository-provided verification string is
     * code — it may only run with an explicit `--run`, and only when the
     * manifest is validly signed by the trusted repository key (or when the
     * user explicitly forces execution with --allow-untrusted-command).
     */
    verify(intentId, opts = {}) {
        const view = this.publicStore.getById(intentId);
        const diagnostics = this.publicStore.getDiagnostics(intentId);
        const record = view ? null : (this.store ? this.store.getById(intentId) : null);
        if (!record && !view && !diagnostics)
            throw new DriftError(`Intent not found: ${intentId}`);
        // A malformed public manifest is refused outright — never verified
        // against the local record (which could mask the corruption) and never
        // executed.
        if (!view && diagnostics && diagnostics.length > 0) {
            const first = diagnostics[0] ?? { field: "$", message: "invalid manifest" };
            return {
                intentId,
                verifyCmd: null,
                signature: "malformed",
                status: "refused",
                exitCode: null,
                stdout: "",
                stderr: "",
                message: `malformed public manifest (${first.field}: ${first.message}). Fix or remove .drift/public/intents/${intentId}.json before verifying.`,
            };
        }
        const verifyCmd = record?.verifyCmd ?? view?.verification ?? null;
        const sig = this.signatureState(intentId, view, record);
        const base = {
            intentId,
            verifyCmd,
            signature: sig.state,
            exitCode: null,
            stdout: "",
            stderr: "",
        };
        if (!verifyCmd) {
            return {
                ...base,
                status: "no-command",
                message: "no verification command recorded",
            };
        }
        if (!opts.run) {
            return {
                ...base,
                status: "not-executed",
                message: `verification command recorded but NOT executed (signature: ${sig.state}). Re-run with \`drift verify ${intentId} --run\` to execute it.`,
            };
        }
        const trusted = sig.state === "valid";
        if (!trusted && !opts.allowUntrustedCommand) {
            return {
                ...base,
                status: "refused",
                message: `refusing to execute the verification command: signature is ${sig.state} (${sig.detail}). Re-run with \`drift verify ${intentId} --run --allow-untrusted-command\` to force execution of repository-provided code.`,
            };
        }
        // Executes with the user's shell ONLY after explicit authorization. The
        // timeout bounds runaway commands; output is captured, never logged as
        // secrets. By DEFAULT the child receives a SANITIZED environment (an
        // allowlist of non-secret variables — never GITHUB_TOKEN / NPM_TOKEN /
        // DRIFT_MASTER_KEY / AWS_* etc.); passing the full process environment
        // requires the explicit `--inherit-env` opt-in, which the CLI gates
        // behind a loud warning.
        const res = spawnSync(verifyCmd, {
            cwd: this.repoRoot,
            shell: true,
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true,
            timeout: opts.timeoutMs ?? VERIFY_TIMEOUT_MS,
            env: opts.inheritEnv ? undefined : sanitizedVerifyEnv(),
        });
        const errno = res.error;
        const timedOut = errno?.code === "ETIMEDOUT" || res.signal === "SIGTERM";
        return {
            ...base,
            status: timedOut ? "timeout" : res.status === 0 ? "pass" : "fail",
            exitCode: res.status,
            stdout: (res.stdout ?? "").toString(),
            stderr: (res.stderr ?? "").toString(),
            message: timedOut
                ? `verification command timed out after ${(opts.timeoutMs ?? VERIFY_TIMEOUT_MS) / 1000}s`
                : res.status === 0
                    ? "verification passed"
                    : `verification failed (exit ${res.status})`,
        };
    }
    // ---------------------------------------------------------------- replay
    replay(intentId, opts = {}) {
        const store = this.requireStore("drift replay");
        const intent = store.getById(intentId);
        if (!intent)
            throw new DriftError(`Intent not found: ${intentId}`);
        if (opts.checkout) {
            checkout(this.repoRoot, intent.gitCommitSha);
        }
        let agentState = intent.agentState ?? null;
        if (agentState && isEncrypted(agentState)) {
            const key = this.getMasterKey();
            if (!key) {
                throw new DriftError("Intent state is encrypted (v0.2.0). Set DRIFT_MASTER_KEY to replay it.", EXIT.KEY);
            }
            try {
                agentState = decryptAesGcm(agentState, key, intent.id);
            }
            catch (err) {
                throw new DriftError(`Failed to decrypt agent state: ${err instanceof Error ? err.message : String(err)}`, EXIT.KEY);
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
    doctor(opts = {}) {
        const checks = [];
        const orphanIds = [];
        const fixed = [];
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
        }
        else {
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
            if (!commitOk)
                orphanIds.push(row.id);
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
        const trailerOnly = [];
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
    untrackPrivateDriftFiles() {
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
    trackedPrivateDriftFiles() {
        const res = execGit(this.repoRoot, ["ls-files", "--", ".drift"], true);
        const allowed = (p) => p === ".drift/.gitignore" ||
            p === ".drift/config.toml" ||
            p.startsWith(".drift/public/");
        return res.stdout
            .split("\n")
            .map((p) => p.trim())
            .filter((p) => p.length > 0 && !allowed(p));
    }
    /** Tracked .drift JSON files whose content carries a `prompt` field. */
    trackedPromptBearingObjects() {
        return this.trackedPrivateDriftFiles().filter((p) => {
            if (!p.endsWith(".json"))
                return false;
            const abs = resolve(this.repoRoot, p);
            if (!existsSync(abs))
                return false;
            try {
                return /\.json$/.test(p) && JSON.stringify(JSON.parse(readFileSync(abs, "utf8"))).includes("\"prompt\"");
            }
            catch {
                return false;
            }
        });
    }
    // ---------------------------------------------------------------- export
    /**
     * Default export is PUBLIC-ONLY (ADR-009): committed manifests + trailer-
     * derived commit association, never a prompt. Private prompts are exported
     * only with `{ includePrivatePrompt: true }` (CLI: --include-private-prompt),
     * which marks the output `containsPrivatePrompts: true` and requires the
     * local store.
     */
    exportJson(opts = {}) {
        const exportedAt = new Date().toISOString();
        if (opts.includePrivatePrompt) {
            if (!this.store) {
                throw new DriftError("Private prompt export requires the local Drift store (run `drift init` first).", EXIT.KEY);
            }
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
            return JSON.stringify({ schemaVersion: 2, containsPrivatePrompts: true, exportedAt, intents: entries }, null, 2);
        }
        const { byId: commitById } = this.intentCommitIndex();
        const { views, errors } = this.publicStore.listWithErrors();
        const entries = views.map((v) => ({
            id: v.id,
            gitSha: commitById.get(v.id) ?? (v.schemaVersion === 1 ? v.commit : null) ?? null,
            authorType: v.agent?.type ?? "HUMAN",
            authorId: v.agent?.identifier ?? "unknown",
            model: v.model ?? null,
            summary: v.summary,
            timestamp: new Date(v.timestamp).toISOString(),
            files: (v.files ?? []).map((f) => ({ path: f.path, mutationType: f.mutationType, summary: f.summary ?? null })),
        }));
        const out = {
            schemaVersion: 2,
            containsPrivatePrompts: false,
            exportedAt,
            intents: entries,
        };
        // Malformed tracked manifests are reported (never rendered as valid, and
        // never silently dropped without a trace).
        if (errors.length > 0) {
            out.malformed = errors.map((e) => ({
                id: e.id,
                errors: e.errors.map((err) => `${err.field}: ${err.message}`),
            }));
        }
        return JSON.stringify(out, null, 2);
    }
    verifyIntentSignature(intentId) {
        const view = this.publicStore.getById(intentId);
        const record = view ? null : (this.store ? this.store.getById(intentId) : null);
        const sig = this.signatureState(intentId, view, record);
        return { ok: sig.state === "valid", detail: sig.detail, state: sig.state };
    }
    /**
     * Shared signature/trust-state resolver used by verify, verify-intent and
     * blame. The committed public manifest is verified against the COMMITTED
     * public key — a newly generated local key (e.g. after `drift init` in a
     * clone) is never used to judge an old record, so the states distinguish
     * valid / invalid / unsigned / unverifiable / untrusted-key honestly.
     */
    signatureState(intentId, view, record) {
        if (view) {
            const pub = this.publicStore.publicKey();
            if (!pub)
                return { state: "unverifiable", detail: "no committed public key in this checkout" };
            if (!view.signature)
                return { state: "unsigned", detail: "manifest has no signature" };
            const valid = this.publicStore.verifySignature(view);
            if (!valid) {
                return { state: "invalid", detail: "signature does not verify against the committed public key" };
            }
            // A cryptographically valid signature with a mismatched `signingKeyId`
            // must not be reported as `valid`: the manifest's declared key id does
            // not match the fingerprint of the trust root that actually verified.
            if (view.schemaVersion === 2 && view.signingKeyId !== signingKeyIdFor(pub)) {
                return {
                    state: "invalid",
                    detail: "signature verifies but manifest signingKeyId does not match the committed key fingerprint",
                };
            }
            return { state: "valid", detail: "signature verifies against the committed public key" };
        }
        // A manifest file exists but fails strict schema validation — never fall
        // back to the local record (which could mask the corruption), never
        // report it as valid.
        const diagnostics = this.publicStore.getDiagnostics(intentId);
        if (diagnostics && diagnostics.length > 0) {
            return {
                state: "malformed",
                detail: `malformed public manifest: ${diagnostics[0]?.field}: ${diagnostics[0]?.message}`,
            };
        }
        if (record && this.store) {
            const obj = this.store.readObjectRecord(record.objectPath);
            if (!obj?.signature) {
                return { state: "unsigned", detail: "legacy record has no signature" };
            }
            const canonical = canonicalJson({
                id: obj.id,
                parentId: obj.parentId,
                author: obj.author,
                prompt: obj.prompt,
                astDelta: obj.astDelta,
                agentState: obj.agentState,
                verifyCmd: obj.verifyCmd,
                timestamp: obj.timestamp,
            });
            const recordedPub = this.store.getMeta("public_key") ?? this.publicKeyPem;
            const valid = verifyPayload(canonical, recordedPub, obj.signature);
            return valid
                ? { state: "valid", detail: "legacy signature verifies against the recorded repository key" }
                : { state: "invalid", detail: "legacy signature does not verify" };
        }
        void intentId;
        return { state: "unverifiable", detail: "no public manifest or local record" };
    }
}
/**
 * Build the git commit message. The subject is the PUBLIC summary — an
 * explicit `--summary` or a generic non-prompt fallback — never prompt text
 * (ADR-009), so a one-line prompt can never leak verbatim into history.
 *
 * `commit-summary` / `none`:
 *   Intent: <public summary, truncated to 72 chars>
 *
 *   Model: <model>              (when recorded)
 *   Verification: <verifyCmd>   (when recorded)
 *   Drift-Intent: <id>
 *
 * `full` (legacy, explicit opt-in): the complete redacted prompt, then the
 * trailer. This mode is visibly unsafe and documented as such.
 */
function buildCommitMessage(opts) {
    if (opts.mode === "full") {
        return `${opts.safePrompt}\n\nDrift-Intent: ${opts.intentId}`;
    }
    const trailers = [];
    if (opts.model)
        trailers.push(`Model: ${opts.model}`);
    if (opts.verifyCmd)
        trailers.push(`Verification: ${opts.verifyCmd}`);
    trailers.push(`Drift-Intent: ${opts.intentId}`);
    const subject = (opts.summary || "Intent recorded").replace(/\s+/g, " ").trim();
    const trimmed = subject.length > 72 ? `${subject.slice(0, 71)}…` : subject;
    return `Intent: ${trimmed}\n\n${trailers.join("\n")}`;
}
function publicKeyFromPrivate(privateKeyPem) {
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
export function ensureDriftGitignore(driftDir) {
    const path = join(driftDir, ".gitignore");
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0));
    const missing = DRIFT_GITIGNORE_RULES.filter((l) => !existingLines.has(l));
    if (missing.length === 0)
        return; // idempotent: nothing to do
    const block = `${existing.trim() ? "\n" : ""}${DRIFT_GITIGNORE_RULES.join("\n")}\n`;
    writeFileSync(path, existing.replace(/[\r\n]+$/, "") + block);
}
/** Map a public manifest to the shared LogEntry shape (no prompt). */
function publicViewToLogEntry(v, gitSha) {
    return {
        id: v.id,
        gitSha,
        authorType: v.agent?.type ?? "HUMAN",
        authorId: v.agent?.identifier ?? "unknown",
        model: v.model ?? null,
        prompt: "",
        summary: v.summary,
        timestamp: v.timestamp,
        files: (v.files ?? []).map((f) => ({
            path: f.path,
            mutationType: f.mutationType,
            summary: f.summary ?? null,
        })),
    };
}
/** Map a public manifest to an IntentRecord-shaped object (private fields empty). */
function publicViewToIntentRecord(v, gitSha) {
    return {
        id: v.id,
        parentId: null,
        gitCommitSha: gitSha,
        author: {
            type: v.agent?.type ?? "HUMAN",
            identifier: v.agent?.identifier ?? "unknown",
            model: v.model ?? undefined,
        },
        prompt: "",
        astDelta: (v.files ?? []).map((f) => ({
            filePath: f.path,
            type: f.mutationType,
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
function safeClamp(n, fallback) {
    if (n === undefined)
        return fallback;
    if (!Number.isFinite(n))
        return fallback;
    return Math.max(1, Math.floor(n));
}
/** Quote a path for shell display in doctor instructions. */
function quotePath(p) {
    return /[^A-Za-z0-9_./-]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p;
}
/**
 * True when `resolved` (absolute) stays inside `root` (absolute). Lexical
 * checks alone would be bypassed by a symlink inside the repo pointing
 * outside, so realpaths are used when the file exists; missing files (e.g.
 * `context` on a deleted-but-recorded path) fall back to the lexical path.
 * The repo root itself is allowed (`rel === ""`).
 */
function isInsideRepo(root, resolved) {
    let rootReal = root;
    let fileReal = resolved;
    try {
        rootReal = realpathSync(root);
    }
    catch {
        // keep lexical
    }
    try {
        fileReal = realpathSync(resolved);
    }
    catch {
        // file may not exist yet — keep lexical
    }
    const rel = relPath(rootReal, fileReal).replace(/\\/g, "/");
    return !isAbsolute(rel) && rel.split("/")[0] !== "..";
}
//# sourceMappingURL=engine.js.map