/**
 * Public provenance (ADR-009, docs/adrs/009-public-private-provenance.md).
 *
 * `.drift/public/` is the ONLY trackable part of a Drift repository:
 *
 *   .drift/public/key.pem              Ed25519 public key (written by init)
 *   .drift/public/intents/<id>.json    signed PublicIntentView per intent
 *
 * Raw prompts, the SQLite database, the content-addressed objects and the
 * signing key live in private (gitignored) locations. This module never sees
 * them: everything here is safe to commit and safe to render publicly.
 *
 * Manifest schemas:
 *   V1 (schemaVersion 1) — legacy. Contains an embedded `commit` SHA that was
 *     part of its signed payload. Read and verified as-is; the `commit` field
 *     is treated as untrusted legacy metadata by consumers.
 *   V2 (schemaVersion 2) — current. Deliberately does NOT embed the containing
 *     Git commit SHA (that would be a self-referential cycle: adding the SHA
 *     changes the tree, which changes the SHA). The intent → commit
 *     association is derived from `Drift-Intent:` git trailers. Adds
 *     `signingKeyId` (fingerprint of the signing public key).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, signPayload, verifyPayload } from "./crypto.js";

/** Maximum length of a public summary (explicit `--summary` or fallback). */
export const PUBLIC_SUMMARY_MAX = 200;
/** Maximum number of files recorded in a public manifest. */
export const PUBLIC_FILES_MAX = 50;

export interface PublicIntentFile {
  path: string;
  mutationType: string;
  summary?: string;
}

export interface PublicAgent {
  type: "HUMAN" | "AGENT";
  identifier: string;
}

/** Fields common to every manifest schema version. */
export interface PublicIntentManifestBase {
  id: string;
  summary: string;
  model?: string;
  agent?: PublicAgent;
  verification?: string;
  files?: PublicIntentFile[];
  /** Epoch-ms creation time (kept across V1/V2 for consumers). */
  timestamp: number;
}

/**
 * Legacy manifest (ADR-009 initial release). The `commit` field is legacy
 * metadata: it was part of the signed payload of V1 manifests only. Consumers
 * prefer the Git-trailer-derived association over this field.
 */
export interface PublicIntentManifestV1 extends PublicIntentManifestBase {
  schemaVersion: 1;
  commit: string;
  signature: string;
}

/**
 * The canonical public record for one intent (current). Everything except
 * `signature` is covered by the Ed25519 signature, verifiable with
 * `.drift/public/key.pem`.
 *
 * Deliberately does NOT contain the SHA of the Git commit that contains it:
 * that would be a self-referential cycle (adding the SHA changes the tree,
 * which changes the SHA). The intent → commit association is derived from the
 * `Drift-Intent:` trailer in the commit message instead (engine
 * `intentCommitIndex`). `signingKeyId` is a fingerprint of the signing public
 * key so consumers can tell which trust root signed a manifest.
 */
export interface PublicIntentManifestV2 extends PublicIntentManifestBase {
  schemaVersion: 2;
  signingKeyId: string;
  signature: string;
}

export type PublicIntentView = PublicIntentManifestV1 | PublicIntentManifestV2;

/** A V2 view with `signature` stripped (the signed payload). */
export type UnsignedPublicIntentView = Omit<PublicIntentManifestV2, "signature">;

/**
 * Strip content that must never reach a public surface (PR comments, step
 * summaries, committed manifests, default JSON): control characters, ANSI
 * escape sequences, HTML-comment delimiters and mention-spam tokens.
 */
export function sanitizePublicText(text: string): string {
  let out = String(text ?? "");
  // ANSI escape sequences (colors/cursor control): ESC [ params m / ESC ] ... BEL
  out = out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  // Control characters (including C0) and DEL — keep \n and \t for layout.
  out = out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  // Neutralize HTML comments so intent metadata cannot inject markers or
  // hide the rest of a rendered comment (GFM supports HTML comments).
  out = out.replace(/<!--[\s\S]*?-->/g, "").replace(/<!--/g, "").replace(/-->/g, "");
  // Neutralize mention/notification spam (@everyone / @here / @all).
  out = out.replace(/@(everyone|here|all)\b/gi, "@\u200b$1");
  return out;
}

/**
 * Sanitize + length-limit a USER-SUPPLIED public summary (ADR-009). The caller
 * redacts secrets first; this never touches the raw prompt. A one-line prompt
 * is deliberately NOT used as a summary: the full first line of a one-line
 * prompt would otherwise be copied verbatim into git history.
 */
export function buildPublicSummary(text: string): string {
  const cleaned = sanitizePublicText(text).trim();
  return cleaned.length <= PUBLIC_SUMMARY_MAX
    ? cleaned
    : `${cleaned.slice(0, PUBLIC_SUMMARY_MAX - 1)}…`;
}

/**
 * Generic fallback summary derived ONLY from non-prompt metadata (intent id,
 * affected file count) — never from prompt text, so it is always safe to
 * commit, clone, and render. Used when the user supplies no explicit summary
 * or when a public manifest is missing.
 */
export function genericPublicSummary(id: string, opts: { fileCount?: number } = {}): string {
  const base = `Drift intent ${id}`;
  const n = opts.fileCount ?? 0;
  return n > 0 ? `${base} (${n} file${n === 1 ? "" : "s"})` : base;
}

export const PUBLIC_KEY_PATH = join("public", "key.pem");
export const PUBLIC_INTENTS_DIR = join("public", "intents");

function isPublicIntentView(value: unknown): value is PublicIntentView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  // A missing/empty `signature` is NOT disqualifying: an unsigned manifest is
  // still provenance (reported as state "unsigned"), it must never silently
  // fall back to the private legacy record.
  if (v.schemaVersion === 1) {
    return typeof v.id === "string" && typeof v.summary === "string" && typeof v.commit === "string";
  }
  if (v.schemaVersion === 2) {
    return typeof v.id === "string" && typeof v.summary === "string" && typeof v.signingKeyId === "string";
  }
  return false;
}

/**
 * Read/write access to `.drift/public/`. Reading never requires the private
 * database, so a fresh clone can still list intents, blame lines and verify
 * signatures (ADR-009 "Fresh-clone behavior").
 */
export class PublicStore {
  constructor(private readonly driftDir: string) {}

  /** Absolute path of a manifest for `id`. */
  manifestPath(id: string): string {
    return join(this.driftDir, PUBLIC_INTENTS_DIR, `${id}.json`);
  }

  /** Absolute path of the committed public key. */
  get keyPath(): string {
    return join(this.driftDir, PUBLIC_KEY_PATH);
  }

  /** Whether the public provenance tree exists (key or any manifest). */
  exists(): boolean {
    return existsSync(this.keyPath) || this.list().length > 0;
  }

  /**
   * The committed Ed25519 public key, or null when absent. Line endings are
   * normalized to LF: on Windows `core.autocrlf` gives tracked PEM files CRLF
   * in the working tree, which would otherwise break string comparisons
   * between the derived public key and the committed trust root.
   */
  publicKey(): string | null {
    if (!existsSync(this.keyPath)) return null;
    try {
      const pem = readFileSync(this.keyPath, "utf8").replace(/\r\n/g, "\n").trim();
      return pem || null;
    } catch {
      return null;
    }
  }

  /** Write the public key file (idempotent). */
  writePublicKey(pem: string): void {
    mkdirSync(dirname(this.keyPath), { recursive: true });
    writeFileSync(this.keyPath, `${pem.replace(/\r\n/g, "\n").trim()}\n`, { mode: 0o644 });
  }

  /** Sign a public view with the repo key and persist it (V2 schema). */
  write(view: UnsignedPublicIntentView, privateKeyPem: string): PublicIntentView {
    const signature = signPayload(canonicalJson(view), privateKeyPem);
    const signed: PublicIntentView = { ...view, signature };
    mkdirSync(dirname(this.manifestPath(view.id)), { recursive: true });
    writeFileSync(this.manifestPath(view.id), `${JSON.stringify(signed, null, 2)}\n`);
    return signed;
  }

  getById(id: string): PublicIntentView | null {
    const path = this.manifestPath(id);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return isPublicIntentView(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Every manifest, newest first (timestamp desc). */
  list(): PublicIntentView[] {
    const dir = join(this.driftDir, PUBLIC_INTENTS_DIR);
    if (!existsSync(dir)) return [];
    const views: PublicIntentView[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const view = this.getById(name.slice(0, -".json".length));
      if (view) views.push(view);
    }
    return views.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Legacy V1-only association: find a V1 manifest whose embedded `commit`
   * field matches. V2 manifests never embed a commit SHA — their association
   * is resolved from `Drift-Intent:` git trailers (engine `intentCommitIndex`),
   * never from this field, so an attacker cannot fabricate an association by
   * editing a manifest.
   */
  findByCommit(commitSha: string): PublicIntentView | null {
    if (!/^[0-9a-f]{40}$/.test(commitSha)) return null;
    return this.list().find((v) => v.schemaVersion === 1 && v.commit === commitSha) ?? null;
  }

  /** Verify the manifest signature against the committed public key. */
  verifySignature(view: PublicIntentView): boolean {
    const pub = this.publicKey();
    if (!pub) return false;
    const { signature, ...unsigned } = view;
    return verifyPayload(canonicalJson(unsigned), pub, signature);
  }
}

/**
 * Short fingerprint of an Ed25519 public key (first 16 hex chars of its
 * SHA-256). Used as `signingKeyId` in V2 manifests and by `drift status` /
 * key-state output — never the private key material.
 */
export function signingKeyIdFor(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem.trim(), "utf8").digest("hex").slice(0, 16);
}
