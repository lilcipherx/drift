#!/usr/bin/env node
/**
 * Drift PR summary comment (GitHub Action).
 *
 * Selects ONLY the commits of the current pull request (immutable base/head
 * SHAs via `git merge-base` + `git rev-list`), reads `Drift-Intent:` trailers
 * from those commits' messages with git's own trailer parser, hydrates the
 * SAFE public manifests (`.drift/public/intents/<id>.json`, ADR-009) and
 * posts/updates one marker comment. The full prompt is never read, never
 * rendered and never posted.
 *
 * Env:
 *   GITHUB_TOKEN            token for the API (from `${{ github.token }}`)
 *   GITHUB_REPOSITORY       owner/repo of the run
 *   GITHUB_EVENT_PATH       event JSON file
 *   GITHUB_STEP_SUMMARY     step summary file (same safe summary is written)
 *   FAIL_ON_COMMENT_ERROR   "true" → exit 1 when the comment cannot be written
 *                           (default: warn + step summary + exit 0)
 *   DRIFT_REPO              repo root override (default: cwd)
 *
 * Graceful behaviour: non-PR events, missing tokens, no intents and fork PR
 * permission failures degrade to an informational step summary, never a
 * crash, never a duplicated comment.
 */

import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

// Distinct marker version 2: the composite Action owns
// `<!-- drift:action-summary:v2 -->` and the GitHub App owns
// `<!-- drift:app-summary:v2 -->` — each integration never edits the other's
// comment. The interim `<!-- drift:pr-summary:v2 -->` marker (used by both
// before the split) and the legacy v1 `<!-- drift:summary -->` marker are
// still recognized for in-place migration, but ONLY when comment ownership
// is independently verified (see isDriftOwnedComment) — a user-authored
// spoofed marker is never touched.
export const SUMMARY_MARKER = "<!-- drift:action-summary:v2 -->";
export const LEGACY_SUMMARY_MARKERS = ["<!-- drift:pr-summary:v2 -->", "<!-- drift:summary -->"];
const MAX_INTENTS = 10;
const MAX_FILES = 10;
const SUMMARY_LIMIT = 500;
const META_LIMIT = 120;
const TOTAL_LIMIT = 12000;

// ---------------------------------------------------------------------------
// Strict public-manifest validation (dependency-free mirror of @drift/core
// parsePublicIntentManifest — a committed manifest is attacker-controlled
// input and must never crash a consumer or be rendered as valid).
// ---------------------------------------------------------------------------

const INTENT_ID_RE = /^did_[0-9a-f]{32}$/;
const MUTATION_ENUM = new Set(["ADDED", "MODIFIED", "DELETED"]);
const MANIFEST_MAX_BYTES = 256 * 1024;
const MANIFEST_SUMMARY_MAX = 2000;
const MANIFEST_FILES_MAX = 50;
const MANIFEST_FILE_PATH_MAX = 1024;
const MANIFEST_FILE_SUMMARY_MAX = 500;
const MANIFEST_META_MAX = 200;
const MANIFEST_VERIFY_MAX = 1000;
const MANIFEST_SIGNATURE_MAX = 4096;
const MANIFEST_TIMESTAMP_MAX = 8_640_000_000_000_000;

export function validateManifest(json, { expectedId } = {}) {
  const errors = [];
  const push = (field, message) => {
    if (errors.length < 50) errors.push({ field, message });
  };
  const fail = () => ({ ok: false, errors });
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    push("$schema", "not an object");
    return fail();
  }
  const sv = json.schemaVersion;
  if (!Number.isInteger(sv) || (sv !== 1 && sv !== 2)) {
    push("schemaVersion", `unsupported schema version ${String(sv)}`);
    return fail();
  }
  const id = json.id;
  if (typeof id !== "string" || !INTENT_ID_RE.test(id)) {
    push("id", "invalid Drift intent id");
    return fail();
  }
  if (expectedId !== undefined && id !== expectedId) {
    push("id", `does not match ${expectedId}`);
    return fail();
  }
  if (typeof json.summary !== "string") push("summary", "expected a string");
  else if (json.summary.length > MANIFEST_SUMMARY_MAX) push("summary", "too long");
  else if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(json.summary)) push("summary", "control characters");
  if (typeof json.timestamp !== "number" || !Number.isInteger(json.timestamp) || json.timestamp < 0) {
    push("timestamp", "expected a non-negative integer");
  } else if (json.timestamp > MANIFEST_TIMESTAMP_MAX) push("timestamp", "out of range");
  if (json.signature !== undefined && json.signature !== null) {
    if (typeof json.signature !== "string" || json.signature.length > MANIFEST_SIGNATURE_MAX) {
      push("signature", "expected a bounded string");
    } else if (json.signature.length > 0) {
      try {
        const decoded = Buffer.from(json.signature, "base64").toString("base64").replace(/=+$/, "");
        if (decoded !== json.signature.replace(/=+$/, "")) push("signature", "not valid base64");
      } catch {
        push("signature", "not valid base64");
      }
    }
  }
  if (json.agent !== undefined) {
    if (typeof json.agent !== "object" || json.agent === null || Array.isArray(json.agent)) {
      push("agent", "expected an object");
    } else {
      if (typeof json.agent.type !== "string" || json.agent.type.length === 0 || json.agent.type.length > 20) push("agent.type", "invalid");
      if (typeof json.agent.identifier !== "string" || json.agent.identifier.length > MANIFEST_META_MAX) push("agent.identifier", "invalid");
    }
  }
  if (json.model !== undefined && (typeof json.model !== "string" || json.model.length > MANIFEST_META_MAX)) push("model", "invalid");
  if (json.verification !== undefined && (typeof json.verification !== "string" || json.verification.length > MANIFEST_VERIFY_MAX)) push("verification", "invalid");
  if (json.files !== undefined) {
    if (!Array.isArray(json.files)) push("files", "expected an array");
    else if (json.files.length > MANIFEST_FILES_MAX) push("files", "too many entries");
    else json.files.forEach((f, i) => {
      if (typeof f !== "object" || f === null || Array.isArray(f)) {
        push(`files[${i}]`, "expected an object");
        return;
      }
      if (typeof f.path !== "string" || f.path.length === 0 || f.path.length > MANIFEST_FILE_PATH_MAX) push(`files[${i}].path`, "invalid");
      if (typeof f.mutationType !== "string" || !MUTATION_ENUM.has(f.mutationType)) push(`files[${i}].mutationType`, "unsupported");
      if (f.summary !== undefined && (typeof f.summary !== "string" || f.summary.length > MANIFEST_FILE_SUMMARY_MAX)) push(`files[${i}].summary`, "invalid");
    });
  }
  if (sv === 1) {
    if (typeof json.commit !== "string" || json.commit.length > 64) push("commit", "invalid");
  } else {
    if (typeof json.signingKeyId !== "string" || !/^[0-9a-f]{16}$/.test(json.signingKeyId)) {
      push("signingKeyId", "must be a 16-hex-char key fingerprint");
    }
  }
  return errors.length > 0 ? fail() : { ok: true, value: json };
}

/** Read + strictly validate one manifest. Never throws on hostile files. */
export function readManifest(repoRoot, id) {
  const path = join(repoRoot, ".drift", "public", "intents", `${id}.json`);
  if (!existsSync(path)) return { manifest: null, errors: null };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { manifest: null, errors: [{ field: "$file", message: "manifest file unreadable" }] };
  }
  if (Buffer.byteLength(raw, "utf8") > MANIFEST_MAX_BYTES) {
    return { manifest: null, errors: [{ field: "$file", message: "manifest exceeds maximum size" }] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { manifest: null, errors: [{ field: "$file", message: "not valid JSON" }] };
  }
  const result = validateManifest(parsed, { expectedId: id });
  return result.ok ? { manifest: result.value, errors: null } : { manifest: null, errors: result.errors };
}

// ---------------------------------------------------------------------------
// Sanitization (mirrors @drift/core sanitizePublicText so this script stays
// dependency-free and safe to run from any checkout).
// ---------------------------------------------------------------------------

export function sanitizeCommentText(text) {
  let out = String(text ?? "");
  out = out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  out = out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  out = out.replace(/<!--[\s\S]*?-->/g, "").replace(/<!--/g, "").replace(/-->/g, "");
  out = out.replace(/@(everyone|here|all)\b/gi, "@\u200b$1");
  return out;
}

function safe(text, limit) {
  const cleaned = sanitizeCommentText(text).replace(/`/g, "").replace(/\s+/g, " ").trim();
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 1)}…`;
}

// ---------------------------------------------------------------------------
// Git helpers (argument arrays only — never interpolated shell strings)
// ---------------------------------------------------------------------------

function git(repoRoot, args, { input } = {}) {
  const res = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Parse the pull_request event into immutable SHAs (never branch names). */
export function parseEvent(rawEventJson) {
  let event;
  try {
    event = JSON.parse(rawEventJson);
  } catch {
    return null;
  }
  const pr = event?.pull_request;
  if (!pr || typeof pr !== "object") return null;
  const { number, base, head } = pr;
  if (!Number.isInteger(number) || !base?.sha || !head?.sha) return null;
  const repo = event?.repository?.full_name;
  if (typeof repo !== "string" || !/^[^/]+\/[^/]+$/.test(repo)) return null;
  return { repo, prNumber: number, baseSha: String(base.sha), headSha: String(head.sha) };
}

/**
 * The commit shas belonging to the PR: `merge-base(base,head)..head`.
 * Returns { ok:false, reason } when the range cannot be computed safely —
 * callers must NOT fall back to repo-wide intent lists.
 */
export function prCommitShas(repoRoot, baseSha, headSha, gitImpl = git) {
  const mb = gitImpl(repoRoot, ["merge-base", baseSha, headSha]);
  if (mb.status !== 0 || !mb.stdout.trim()) {
    return { ok: false, reason: "merge-base", shas: [] };
  }
  const mergeBase = mb.stdout.trim();
  const rev = gitImpl(repoRoot, ["rev-list", "--reverse", `${mergeBase}..${headSha}`]);
  if (rev.status !== 0) {
    return { ok: false, reason: "rev-list", shas: [] };
  }
  const shas = rev.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f]{40}$/.test(s));
  return { ok: true, shas };
}

// ---------------------------------------------------------------------------
// Trailer parsing — git's own `interpret-trailers --parse`, with a small
// git-trailer-aligned fallback parser when git is unavailable.
// ---------------------------------------------------------------------------

const ID_RE = /^did_[0-9a-f]{32}$/;
const TRAILER_LINE_RE = /^([A-Za-z0-9-]+):[ \t]*(.*)$/;

/** Fallback parser: trailers live in the LAST paragraph of the message. */
export function parseGitTrailers(message) {
  const lines = String(message ?? "").split(/\r?\n/);
  let last = [];
  let cur = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (cur.length > 0) {
        last = cur;
        cur = [];
      }
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) last = cur;
  const out = [];
  let i = 0;
  while (i < last.length) {
    const m = TRAILER_LINE_RE.exec(last[i]);
    if (!m) break;
    let value = m[2];
    i++;
    while (i < last.length && /^[ \t]+/.test(last[i])) {
      value += ` ${last[i].trim()}`;
      i++;
    }
    out.push({ token: m[1], value });
  }
  return out;
}

/** All valid Drift-Intent ids in a commit message (deduped, order kept). */
export function extractDriftIntentIds(message, gitImpl = git, repoRoot = process.cwd()) {
  const res = gitImpl(repoRoot, ["interpret-trailers", "--parse"], { input: message });
  const trailers =
    res.status === 0
      ? res.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .map((l) => {
            const m = TRAILER_LINE_RE.exec(l);
            return m ? { token: m[1], value: m[2] } : null;
          })
          .filter((t) => t !== null)
      : parseGitTrailers(message);
  const ids = [];
  const seen = new Set();
  for (const trailer of trailers) {
    if (trailer.token !== "Drift-Intent") continue;
    const id = trailer.value.trim();
    if (ID_RE.test(id) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Intent loading — public manifests only
// ---------------------------------------------------------------------------

/** Read a file's content at a git ref (`git show ref:path`), or null. */
export function getFileAt(repoRoot, ref, path, gitImpl = git) {
  const res = gitImpl(repoRoot, ["show", `${ref}:${path}`]);
  if (res.status !== 0) return null;
  return res.stdout;
}

/** Key-order-stable JSON stringify (mirrors @drift/core canonicalJson). */
export function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** Verify a manifest's Ed25519 signature against a PEM public key. */
export function verifyManifestSignature(manifest, publicKeyPem) {
  if (!manifest || typeof manifest !== "object") return false;
  if (typeof manifest.signature !== "string" || !manifest.signature) return false;
  if (typeof publicKeyPem !== "string" || !publicKeyPem.includes("PUBLIC KEY")) return false;
  const { signature, ...unsigned } = manifest;
  try {
    const key = createPublicKey(publicKeyPem.trim());
    return nodeVerify(
      null,
      Buffer.from(canonicalJson(unsigned), "utf8"),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the signature/trust state of one manifest against the TRUSTED base
 * key and the PR-head key (which is untrusted until a controlled rotation):
 *   valid           — verifies against the base-branch trust root.
 *   invalid         — a signature exists but verifies against neither key,
 *                     OR (bootstrap) the head signature fails cryptographic
 *                     verification — a failed signature is NEVER "bootstrap".
 *   unsigned        — no signature recorded.
 *   unverifiable    — no usable verification material (malformed key, or no
 *                     base key and no head key).
 *   untrusted-key   — verifies ONLY against a PR-replaced key (rotation).
 *   bootstrap       — base has no Drift key at all AND the head signature
 *                     verifies against the head key (initial adoption).
 *   malformed       — the manifest fails strict schema validation.
 */
export function signatureStateFor(manifest, { baseKey, headKey, malformed = false }) {
  if (malformed) return "malformed";
  if (!manifest) return "missing";
  if (typeof manifest.signature !== "string" || !manifest.signature) return "unsigned";
  const baseUsable = baseKey != null && looksLikePublicKey(baseKey);
  const headUsable = headKey != null && looksLikePublicKey(headKey);
  // A malformed base trust root is unusable — mark unverifiable rather than
  // guessing. (If the PR also replaced it, the key-change warning fires
  // separately.)
  if (baseKey != null && !baseUsable) return "unverifiable";
  const baseValid = baseUsable && verifyManifestSignature(manifest, baseKey);
  const headValid = headUsable && verifyManifestSignature(manifest, headKey);
  if (baseUsable) {
    if (baseValid) {
      // A cryptographically valid signature with a mismatched V2
      // `signingKeyId` must not be reported as valid.
      if (manifest.schemaVersion === 2 && manifest.signingKeyId !== signingKeyIdFor(baseKey)) return "invalid";
      return "valid";
    }
    if (headValid) return "untrusted-key";
    return "invalid";
  }
  // No base trust root (initial adoption): the head signature must actually
  // VERIFY to count as bootstrap — a failed signature is simply invalid.
  if (headUsable && headValid) return "bootstrap";
  if (headUsable) return "invalid";
  return "unverifiable";
}

function looksLikePublicKey(pem) {
  return typeof pem === "string" && pem.includes("PUBLIC KEY");
}

/** Short sha256 fingerprint of a PEM public key (first 16 hex chars). */
export function signingKeyIdFor(publicKeyPem) {
  return createHash("sha256").update(String(publicKeyPem ?? "").trim(), "utf8").digest("hex").slice(0, 16);
}

/**
 * Walk PR commits, collect their intent ids (in order, deduped), hydrate from
 * `.drift/public/intents/`. When a public manifest is missing the summary is
 * a generic NON-PROMPT fallback (`Drift intent <id>`) — the commit subject is
 * never used, because in legacy `full`-mode commits the subject may contain a
 * complete private prompt.
 */
export function intentsFromCommits({ repoRoot, commits, gitImpl = git, readManifestImpl = readManifest }) {
  const ids = [];
  const seen = new Set();
  const intro = new Map(); // intent id -> sha (first PR commit referencing it)
  for (const sha of commits) {
    const res = gitImpl(repoRoot, ["log", "-1", "--format=%B", sha]);
    if (res.status !== 0) continue;
    const message = res.stdout;
    for (const id of extractDriftIntentIds(message, gitImpl, repoRoot)) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
      if (!intro.has(id)) intro.set(id, sha);
    }
  }

  const intents = [];
  for (const id of ids) {
    const loaded = readManifestImpl(repoRoot, id);
    const manifest = loaded?.manifest ?? null;
    const malformed = Boolean(loaded && Array.isArray(loaded.errors) && loaded.errors.length > 0);
    intents.push({
      id,
      summary: manifest?.summary ?? `Drift intent ${id}`,
      missingManifest: !manifest && !malformed,
      malformedManifest: malformed,
      model: manifest?.model ?? null,
      authorId: manifest?.agent?.identifier ?? null,
      authorType: manifest?.agent?.type ?? null,
      verification: manifest?.verification ?? null,
      files: Array.isArray(manifest?.files)
        ? manifest.files.map((f) => ({
            path: f?.path ?? "?",
            mutationType: f?.mutationType ?? "MODIFIED",
            summary: f?.summary ?? null,
          }))
        : [],
      commit: intro.get(id) ?? (manifest && typeof manifest.commit === "string" ? manifest.commit : null),
    });
  }
  return intents;
}

// ---------------------------------------------------------------------------
// Public-provenance integrity audit (append-only rules)
// ---------------------------------------------------------------------------

/**
 * Audit ALL changes under `.drift/public/` between the merge base and the PR
 * head — not just trailer-derived intents. A pull request can tamper with
 * public provenance without introducing any new `Drift-Intent:` trailer, and
 * that must be visible. Rules (ADR-009 append-only model):
 *
 *   added manifest      → OK only when introduced by a PR commit whose message
 *                         carries exactly ONE matching Drift-Intent trailer
 *                         (atomic association); otherwise an orphan.
 *   modified manifest   → violation (append-only).
 *   deleted manifest    → violation (append-only).
 *   renamed manifest    → violation (append-only).
 *   trailer for an id whose manifest already existed at base → replay.
 *   one id referenced by >1 distinct PR commit → ambiguous association.
 *   trailer without manifest → missing-manifest (not a violation; surfaced
 *                         as the missing state).
 *
 * Returns { violations, replayIds, ambiguousIds, orphanIds } where each
 * violation is { code, id, detail } (codes: modified/deleted/renamed/orphan).
 */
export function auditPublicProvenance({ repoRoot, baseSha, headSha, commits, gitImpl = git }) {
  const violations = [];
  const replayIds = [];
  const ambiguousIds = [];
  const orphanIds = [];
  const mb = gitImpl(repoRoot, ["merge-base", baseSha, headSha]);
  const mergeBase = mb.status === 0 && mb.stdout.trim() ? mb.stdout.trim() : baseSha;

  // NUL-safe diff of the public tree (bounded output).
  const diff = gitImpl(repoRoot, ["diff", "--name-status", "-z", mergeBase, headSha, "--", ".drift/public"]);
  const parts = (diff.stdout ?? "").split("\0").filter((p) => p.length > 0);
  const entries = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i++] ?? "";
    const code = status[0];
    if (code === "R") {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      if (oldPath && newPath) entries.push({ status: "R", oldPath, newPath });
    } else {
      const path = parts[i++];
      if (path) entries.push({ status: code, path });
    }
  }

  const manifestId = (path) => {
    const m = /^\.drift\/public\/intents\/(did_[0-9a-f]{32})\.json$/.exec(path);
    return m ? m[1] : null;
  };

  // Which ids do the PR commits reference, and how often? (ambiguous = >1)
  const commitCount = new Map();
  const introCommit = new Map();
  for (const sha of commits) {
    const res = gitImpl(repoRoot, ["log", "-1", "--format=%B", sha]);
    if (res.status !== 0) continue;
    for (const id of extractDriftIntentIds(res.stdout, gitImpl, repoRoot)) {
      commitCount.set(id, (commitCount.get(id) ?? 0) + 1);
      if (!introCommit.has(id)) introCommit.set(id, sha);
    }
  }

  for (const entry of entries) {
    if (entry.status === "R") {
      const oldId = manifestId(entry.oldPath);
      const newId = manifestId(entry.newPath);
      if (oldId || newId) {
        violations.push({ code: "renamed", id: oldId ?? newId, detail: `${entry.oldPath} → ${entry.newPath}` });
      }
      continue;
    }
    const id = manifestId(entry.path);
    if (entry.status === "A" && id) {
      const n = commitCount.get(id) ?? 0;
      if (n === 0) {
        violations.push({
          code: "orphan",
          id,
          detail: "new public manifest added without any Drift-Intent trailer on this PR",
        });
        orphanIds.push(id);
        continue;
      }
      if (n > 1) {
        ambiguousIds.push(id);
        continue;
      }
      // Exactly one reference: atomic association requires the file's
      // introducing commit to be the PR commit that carries the trailer.
      const introduced = gitImpl(repoRoot, ["log", "-1", "--format=%H", "--diff-filter=A", `${mergeBase}..${headSha}`, "--", entry.path]);
      const introSha = introduced.status === 0 ? introduced.stdout.trim() : "";
      if (!introSha || introCommit.get(id) !== introSha) {
        violations.push({
          code: "orphan",
          id,
          detail: `new public manifest introduced by a different commit than its Drift-Intent trailer${introSha ? ` (introduced by ${introSha.slice(0, 7)})` : ""}`,
        });
        orphanIds.push(id);
      }
      continue;
    }
    if (id) {
      if (entry.status === "M") violations.push({ code: "modified", id, detail: "an existing public manifest must be append-only" });
      else if (entry.status === "D") violations.push({ code: "deleted", id, detail: "an existing public manifest must not be deleted by a pull request" });
    }
  }

  // Replay: a PR commit references an intent whose manifest already exists
  // on the base branch.
  for (const [id] of commitCount) {
    const exists = gitImpl(repoRoot, ["cat-file", "-e", `${baseSha}:.drift/public/intents/${id}.json`]).status === 0;
    if (exists) replayIds.push(id);
  }
  // Ambiguous: the same intent id referenced from multiple distinct commits.
  for (const [id, n] of commitCount) {
    if (n > 1) ambiguousIds.push(id);
  }
  return { violations, replayIds, ambiguousIds, orphanIds };
}

// ---------------------------------------------------------------------------
// Comment building (safe public data only)
// ---------------------------------------------------------------------------

/** Human label for a manifest signature/trust state (never the raw prompt). */
const SIGNATURE_LABELS = {
  valid: "✓ signed (trusted repository key)",
  invalid: "⚠ invalid signature",
  unsigned: "no signature",
  unverifiable: "⚠ unverifiable (no verification key)",
  "untrusted-key": "⚠ unverified — signed with a different key than the base branch",
  bootstrap: "unverified bootstrap (base branch has no Drift key yet)",
  malformed: "⚠ malformed public manifest — not verified",
  missing: "⚠ public provenance manifest missing",
};

/**
 * Prominent trust-root warning (also used for key-only PRs, where it is the
 * entire body). Never auto-trusts a replacement key.
 */
export const TRUST_ROOT_WARNING =
  "## ⚠ Drift trust-root change detected\n\nThis pull request modifies `.drift/public/key.pem`.\n\nNew provenance cannot be trusted automatically until the key rotation is reviewed through the documented rotation process.";

/**
 * Build the summary comment body. Returns null when there is nothing to say
 * (no intents, no trust-root change, no provenance-integrity violations).
 */
export function buildSummary(intents, { keyChange, audit } = {}) {
  const hasIntents = Array.isArray(intents) && intents.length > 0;
  const integrityIssues =
    audit &&
    (audit.violations.length > 0 || audit.replayIds.length > 0 || audit.ambiguousIds.length > 0);
  if (!hasIntents && !keyChange && !integrityIssues) return null;
  const lines = [SUMMARY_MARKER];
  if (keyChange) {
    lines.push(TRUST_ROOT_WARNING);
    if (!hasIntents && !integrityIssues) return lines.join("\n");
    lines.push("", "---", "");
  }
  lines.push("## Drift — Why this changed");
  lines.push("");
  const shown = intents.slice(0, MAX_INTENTS);
  const truncatedIntents = intents.length > MAX_INTENTS;
  lines.push(`${shown.length} intent${shown.length === 1 ? "" : "s"} on this PR`);
  for (const intent of shown) {
    lines.push("", `### Intent \`${safe(intent.id, 12)}\``, "");
    if (intent.missingManifest) {
      lines.push("_(public provenance manifest missing — summary is a generic fallback)_");
    } else {
      lines.push(safe(intent.summary, SUMMARY_LIMIT) || "_(no public summary recorded)_");
    }
    if (intent.signatureState) {
      lines.push("", `_${SIGNATURE_LABELS[intent.signatureState] ?? "signature status unknown"}_`);
    }

    const meta = [];
    if (intent.authorId) meta.push(safe(intent.authorId, META_LIMIT));
    if (intent.authorType && intent.authorType !== "unknown") meta.push(`(${safe(intent.authorType, 16)})`);
    if (intent.model) meta.push(`model ${safe(intent.model, META_LIMIT)}`);
    if (meta.length > 0) {
      lines.push("", "### Generated with", "");
      lines.push(meta.join(" · "));
    }

    if (intent.files.length > 0) {
      lines.push("", "### Affected code", "");
      for (const f of intent.files.slice(0, MAX_FILES)) {
        const detail = f.summary ? ` — ${safe(f.summary, 90)}` : "";
        lines.push(`- \`${safe(f.path, 200)}\` (**${safe(f.mutationType, 16)}**)${detail}`);
      }
      if (intent.files.length > MAX_FILES) lines.push(`- … +${intent.files.length - MAX_FILES} more`);
    }

    if (intent.verification) {
      lines.push("", "### Verification", "");
      lines.push(`- \`${safe(intent.verification, META_LIMIT)}\``);
    }

    lines.push("", "### Trace", "");
    lines.push(`- Intent: ${safe(intent.id, 40)}`);
    if (intent.commit) lines.push(`- Commit: \`${String(intent.commit).slice(0, 7)}\``);
  }
  if (truncatedIntents) {
    lines.push("", `_… and ${intents.length - MAX_INTENTS} more intent(s) not shown._`);
  }
  if (integrityIssues) {
    lines.push("", "## ⚠ Public provenance integrity violations", "");
    for (const v of audit.violations) {
      lines.push(`- **${safe(v.code, 16)}** \`${safe(v.id, 40)}\` — ${safe(v.detail, 200)}`);
    }
    for (const id of audit.replayIds) {
      lines.push(`- **replayed** \`${safe(id, 40)}\` — this intent's manifest already exists on the base branch; a new commit must not re-reference it`);
    }
    for (const id of audit.ambiguousIds) {
      lines.push(`- **ambiguous** \`${safe(id, 40)}\` — the intent id is referenced by more than one commit on this PR`);
    }
  }
  lines.push("", "---", "_Generated by [Drift](https://github.com/lilcipherx/drift) — Git tracks what changed. Drift tracks why._");
  let body = lines.join("\n");
  if (body.length > TOTAL_LIMIT) {
    body = `${body.slice(0, TOTAL_LIMIT)}\n\n_(summary truncated for size)_`;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Idempotent comment upsert
// ---------------------------------------------------------------------------

/**
 * A comment belongs to the ACTION ONLY when GitHub itself attests that the
 * composite Action authored it (`github-actions[bot]` login is
 * server-controlled — a commenter cannot set it). Comments authored by the
 * GitHub App (`performed_via_github_app`) are owned by the App and the
 * Action must NEVER edit them; user-authored bodies that merely contain a
 * marker are spoofs and are never touched.
 */
export function isDriftOwnedComment(comment) {
  if (!comment || typeof comment !== "object") return false;
  if (typeof comment.body !== "string") return false;
  const hasMarker =
    comment.body.includes(SUMMARY_MARKER) ||
    LEGACY_SUMMARY_MARKERS.some((m) => comment.body.includes(m));
  if (!hasMarker) return false;
  const login = comment.user?.login;
  if (typeof login === "string" && login === "github-actions[bot]") return true;
  // A performed_via_github_app comment is the App's, not the Action's.
  return false;
}

/** Extract the absolute `rel="next"` URL from a GitHub Link header. */
export function nextPageUrl(link, fallbackUrl) {
  if (!link) return null;
  for (const part of link.split(",").map((p) => p.trim())) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Post the comment, or update the first genuine Drift comment in place
 * (idempotent across `synchronize` deliveries). Only ownership-verified
 * comments are updated (marker v2 preferred, legacy v1 migrated when owned).
 * Never posts a duplicate when an owned marker comment exists; spoofed
 * user-authored markers are left untouched and cannot block the official
 * summary.
 */
export async function upsertComment({ token, repo, issueNumber, body, fetchImpl = fetch }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "drift-action",
  };
  // Paginate through the Link header (bounded at 10 pages) so the Drift
  // marker comment is found even on heavily-commented PRs — never stop at
  // the first 100 comments.
  const comments = [];
  let listUrl = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?per_page=100`;
  for (let page = 0; page < 10 && listUrl; page++) {
    const list = await fetchImpl(listUrl, { headers });
    if (!list.ok) throw new Error(`list comments: HTTP ${list.status}`);
    let batch = [];
    try {
      batch = (await list.json()) ?? [];
    } catch {
      throw new Error("list comments: malformed API response");
    }
    if (!Array.isArray(batch)) throw new Error("list comments: malformed API response");
    comments.push(...batch);
    listUrl = nextPageUrl(list.headers?.get?.("link") ?? null, listUrl);
  }
  // Deterministic selection: first owned v2-marker comment, else first owned
  // legacy v1-marker comment (migration). Duplicate official comments are
  // collapsed onto the single canonical one.
  const owned = comments.filter(isDriftOwnedComment);
  const existing =
    owned.find((c) => c.body.includes(SUMMARY_MARKER)) ??
    owned.find((c) => LEGACY_SUMMARY_MARKERS.some((m) => c.body.includes(m))) ??
    undefined;
  if (existing) {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues/comments/${existing.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`update comment: HTTP ${res.status}`);
    return { action: "updated", id: existing.id };
  }
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`post comment: HTTP ${res.status}`);
  let posted;
  try {
    posted = await res.json();
  } catch {
    throw new Error("post comment: malformed API response");
  }
  const id = Number(posted?.id);
  if (!Number.isInteger(id)) throw new Error("post comment: malformed API response");
  return { action: "commented", id };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function appendStepSummary(text) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, `${text}\n`);
  } catch {
    /* step summary is best-effort */
  }
}

async function main() {
  // 1. event
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) {
    console.log("pr-comment: GITHUB_EVENT_PATH missing or unreadable — skipping");
    return;
  }
  let rawEvent;
  try {
    rawEvent = readFileSync(eventPath, "utf8");
  } catch {
    console.log("pr-comment: cannot read event file — skipping");
    return;
  }
  const event = parseEvent(rawEvent);
  if (!event) {
    console.log("pr-comment: not a pull_request event — skipping");
    return;
  }

  const failOnError = process.env.FAIL_ON_COMMENT_ERROR === "true";
  const repoRoot = process.env.DRIFT_REPO || process.cwd();

  // 2. PR commit range — never the last N repo-wide intents.
  const range = prCommitShas(repoRoot, event.baseSha, event.headSha);
  if (!range.ok || range.shas.length === 0) {
    console.log(`pr-comment: cannot compute PR commit range (${range.reason}) — skipping`);
    appendStepSummary(
      `_Drift: could not compute the pull-request commit range (${range.reason}). Make sure \`actions/checkout\` uses \`fetch-depth: 0\` so base history is available._`,
    );
    return;
  }

  // 3. Trust-root evaluation FIRST — a key-only PR (no intents at all) must
  // still surface a blocking trust-root warning instead of exiting through
  // the "no intents" path.
  const baseKey = getFileAt(repoRoot, event.baseSha, ".drift/public/key.pem");
  const headKey = getFileAt(repoRoot, "HEAD", ".drift/public/key.pem");
  let keyChange = "none";
  if (!baseKey && headKey) keyChange = "bootstrap";
  else if (baseKey && !headKey) keyChange = "removed";
  else if (baseKey && headKey && baseKey.trim() !== headKey.trim()) keyChange = "replaced";
  const hasKeyChange = keyChange === "replaced" || keyChange === "removed";

  // 4. intents from PR commits only, with per-intent signature/trust states.
  const intents = intentsFromCommits({ repoRoot, commits: range.shas });
  for (const intent of intents) {
    const loaded = readManifest(repoRoot, intent.id);
    intent.signatureState = signatureStateFor(loaded.manifest, {
      baseKey,
      headKey,
      malformed: Boolean(loaded.errors && loaded.errors.length > 0),
    });
  }

  // 4b. Provenance integrity: scan the WHOLE `.drift/public/` diff, not just
  // trailer-derived intents — tampering with existing manifests (modified /
  // deleted / renamed), orphan additions, replays and ambiguous associations
  // must be visible even when the PR has zero ordinary intents.
  const audit = auditPublicProvenance({ repoRoot, baseSha: event.baseSha, headSha: event.headSha, commits: range.shas });

  // 5. The body always carries the trust-root warning for key changes; for a
  // key-only PR the warning IS the body.
  const body = buildSummary(intents, { keyChange: hasKeyChange, audit });
  if (!body) {
    console.log("pr-comment: no Drift intents, no trust-root change and no provenance violations on this PR — nothing to summarize");
    appendStepSummary("_Drift: no Drift intents on this PR — nothing to summarize._");
    return;
  }

  // 6. The safe summary ALWAYS lands in the step summary — before any token
  // check, so a missing/read-only GITHUB_TOKEN never suppresses it.
  appendStepSummary(body);

  // 7. Comment (idempotent), degrading gracefully on fork/read-only tokens.
  const token = process.env.GITHUB_TOKEN ?? "";
  if (!token) {
    console.log("pr-comment: GITHUB_TOKEN not set — step summary written, comment skipped");
    return;
  }
  try {
    const result = await upsertComment({ token, repo: event.repo, issueNumber: event.prNumber, body });
    console.log(`pr-comment: ${result.action} comment #${result.id}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`pr-comment: warning: could not ${message}`);
    if (failOnError) {
      console.error("pr-comment: FAIL_ON_COMMENT_ERROR is set — exiting non-zero");
      process.exitCode = 1;
    }
  }
}

// Run only when executed as a script, not when imported by tests.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
