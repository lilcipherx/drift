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
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

export const SUMMARY_MARKER = "<!-- drift:summary -->";
const MAX_INTENTS = 10;
const MAX_FILES = 10;
const SUMMARY_LIMIT = 500;
const META_LIMIT = 120;
const TOTAL_LIMIT = 12000;

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

export function readManifest(repoRoot, id) {
  const path = join(repoRoot, ".drift", "public", "intents", `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

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
 *   invalid         — a signature exists but verifies against neither key.
 *   unsigned        — no signature recorded.
 *   unverifiable    — no verification material available (no base key).
 *   untrusted-key   — verifies ONLY against a PR-replaced key (rotation).
 *   bootstrap       — base has no Drift key at all (initial adoption).
 */
export function signatureStateFor(manifest, { baseKey, headKey }) {
  if (!manifest) return "missing";
  if (typeof manifest.signature !== "string" || !manifest.signature) return "unsigned";
  if (!baseKey && !headKey) return "unverifiable";
  if (baseKey && verifyManifestSignature(manifest, baseKey)) return "valid";
  if (headKey && verifyManifestSignature(manifest, headKey)) {
    return baseKey ? "untrusted-key" : "bootstrap";
  }
  if (!baseKey) return "bootstrap";
  return "invalid";
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
    const manifest = readManifestImpl(repoRoot, id);
    intents.push({
      id,
      summary: manifest?.summary ?? `Drift intent ${id}`,
      missingManifest: !manifest,
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
  missing: "⚠ public provenance manifest missing",
};

/** Build the summary comment body. Returns null when there is nothing to say. */
export function buildSummary(intents) {
  if (!Array.isArray(intents) || intents.length === 0) return null;
  const shown = intents.slice(0, MAX_INTENTS);
  const truncatedIntents = intents.length > MAX_INTENTS;
  const lines = [SUMMARY_MARKER, "## Drift — Why this changed", ""];
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
 * Post the comment, or update the FIRST existing Drift comment in place
 * (idempotent across `synchronize` deliveries). Never posts a duplicate when
 * a marker comment already exists; never touches comments without the marker.
 */
export async function upsertComment({ token, repo, issueNumber, body, fetchImpl = fetch }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "drift-action",
  };
  const list = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?per_page=100`, { headers });
  if (!list.ok) throw new Error(`list comments: HTTP ${list.status}`);
  let comments = [];
  try {
    comments = (await list.json()) ?? [];
  } catch {
    throw new Error("list comments: malformed API response");
  }
  const existing = Array.isArray(comments)
    ? comments.find((c) => typeof c?.body === "string" && c.body.includes(SUMMARY_MARKER))
    : undefined;
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

  const token = process.env.GITHUB_TOKEN ?? "";
  if (!token) {
    console.log("pr-comment: GITHUB_TOKEN not set — skipping comment (CI check still ran)");
    appendStepSummary("_Drift: GITHUB_TOKEN not set — PR comment skipped._");
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

  // 3. intents from PR commits only.
  const intents = intentsFromCommits({ repoRoot, commits: range.shas });

  // 3b. Trust-root verification (ADR-009 PR key policy): manifests are
  // verified against the BASE-branch key — the PR head key is untrusted until
  // a controlled rotation. A PR that replaces .drift/public/key.pem is never
  // silently trusted.
  const baseKey = getFileAt(repoRoot, event.baseSha, ".drift/public/key.pem");
  const headKey = getFileAt(repoRoot, "HEAD", ".drift/public/key.pem");
  const keyChanged =
    Boolean(baseKey) && Boolean(headKey) && baseKey.trim() !== headKey.trim();
  for (const intent of intents) {
    const manifest = readManifest(repoRoot, intent.id);
    intent.signatureState = signatureStateFor(manifest, { baseKey, headKey });
  }
  const body = buildSummary(intents);
  if (!body) {
    console.log("pr-comment: no Drift intents on this PR — nothing to summarize");
    appendStepSummary("_Drift: no Drift intents on this PR — nothing to summarize._");
    return;
  }

  // 3c. A PR that modifies the public trust root must be prominent.
  if (keyChanged) {
    appendStepSummary(
      "⚠ **Warning: this pull request changes the Drift public signing key (.drift/public/key.pem).** New provenance on this PR is marked unverified until a controlled key-rotation process is approved.",
    );
  }

  // 4. The safe summary always lands in the step summary.
  appendStepSummary(body);

  // 5. Comment (idempotent), degrading gracefully on fork/read-only tokens.
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
