/**
 * Read `Drift-Intent: <id>` trailers from pull request commits (git-trailer
 * aligned) and hydrate the SAFE public provenance from
 * `.drift/public/intents/<id>.json` (ADR-009).
 *
 * Private data (prompts, `objects/`, `drift.db`) is never read here and
 * never rendered: comments show only the public summary + metadata.
 *
 * Trust model: manifests are verified against the BASE-branch public key —
 * the PR head key is untrusted until a controlled rotation. A PR that
 * replaces `.drift/public/key.pem` is detected and its provenance is marked
 * unverified, never silently trusted. Manifests pass STRICT schema
 * validation (the same rules as `@drift/core`): malformed repository data
 * is reported as `malformed`, never rendered as valid, never a crash.
 */

import {
  MANIFEST_MAX_BYTES,
  canonicalJson,
  extractDriftIntentIds,
  parsePublicIntentManifest,
  signingKeyIdFor,
  tryParseTrustRoot,
  verifyPayload,
  type ManifestValidationError,
  type PublicIntentView,
} from "@drift/core";
import type { GitHubClientLike, PullCommit } from "./github.js";
import type { ProvenanceAudit } from "./trust.js";

export interface IntentFileView {
  path: string;
  mutationType: string;
  summary: string | null;
}

/**
 * Signature/trust state of a manifest against the base-branch trust root:
 *   valid           — verifies against the base key (and V2 signingKeyId
 *                     matches the base key fingerprint).
 *   invalid         — a signature exists but does not verify against base/head
 *                     (including a failed bootstrap signature).
 *   unsigned        — no signature recorded.
 *   unverifiable    — no usable verification material (malformed key).
 *   untrusted-key   — verifies only against a PR-replaced key (rotation).
 *   bootstrap       — base branch has no Drift key AND the head signature
 *                     verifies against the head key (initial adoption).
 *   malformed       — the manifest fails strict schema validation.
 *   missing         — no manifest found.
 */
export type SignatureState =
  | "valid"
  | "invalid"
  | "unsigned"
  | "unverifiable"
  | "untrusted-key"
  | "bootstrap"
  | "malformed"
  | "missing";

export interface IntentView {
  id: string;
  authorType: string;
  authorId: string;
  model: string | null;
  /**
   * Safe public summary — the ONLY text ever rendered. When a manifest is
   * missing or malformed, a generic non-prompt fallback (`Drift intent <id>`)
   * is used; the commit subject is NEVER used (legacy `full`-mode subjects may
   * contain a complete private prompt).
   */
  summary: string;
  verifyCmd: string | null;
  files: IntentFileView[];
  /** True only when the manifest is validly signed by the base trust root. */
  signature: boolean;
  signatureState: SignatureState;
  /** True when no public manifest exists for this intent. */
  missingManifest: boolean;
  /** True when a manifest exists but fails strict schema validation. */
  malformedManifest: boolean;
  /** First validation error, when malformed (actionable diagnostic). */
  manifestError?: string;
}

/** Extract unique, valid Drift-Intent ids referenced by a set of commits. */
export function extractIntentIds(commits: PullCommit[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const commit of commits) {
    for (const id of extractDriftIntentIds(commit.message)) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

export interface LoadedManifest {
  manifest: PublicIntentView | null;
  errors: ManifestValidationError[] | null;
}

/**
 * Strictly parse a manifest fetched from the GitHub API. `expectedId` must
 * match both the requested intent id and (indirectly) the file it was loaded
 * from — callers only fetch `intents/<id>.json`, so a mismatched embedded id
 * is rejected outright. The raw BYTE length is enforced BEFORE `JSON.parse`
 * so an arbitrarily large tracked file is never loaded into the parser
 * (issue 8) — the connector already returns a string, so the length check
 * happens before any structural work.
 */
export function parseLoadedManifest(raw: string | null, expectedId: string): LoadedManifest {
  if (!raw) return { manifest: null, errors: null };
  if (Buffer.byteLength(raw, "utf8") > MANIFEST_MAX_BYTES) {
    return {
      manifest: null,
      errors: [{ field: "$file", message: `manifest exceeds maximum size ${MANIFEST_MAX_BYTES} bytes` }],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { manifest: null, errors: [{ field: "$file", message: "manifest is not valid JSON" }] };
  }
  const result = parsePublicIntentManifest(parsed, { expectedId });
  return result.ok ? { manifest: result.value, errors: null } : { manifest: null, errors: result.errors };
}

/**
 * Whether a PEM string is a usable Drift trust root — decided ONLY by the
 * shared strict parser (valid Ed25519 public key). A malformed base key is
 * unusable verification material and is never treated as trusted.
 */
function looksLikePublicKey(pem: string | null | undefined): boolean {
  return tryParseTrustRoot(pem).state === "valid";
}

/**
 * Resolve the signature/trust state of a manifest against the trusted base
 * key and the (untrusted) PR-head key. Identical semantics to the Action's
 * `signatureStateFor` so the two integrations can never diverge:
 *
 *   base key exists:  verifies → valid; only head verifies → untrusted-key;
 *                     fails all → invalid.
 *   no base key:      head verifies → bootstrap; head signature fails → invalid
 *                     (a failed signature is NEVER bootstrap); no head key →
 *                     unverifiable.
 *   malformed base key → unverifiable (plus a key-change failure when the PR
 *                     introduced it as a replacement).
 */
export function signatureStateFor(
  loaded: LoadedManifest,
  baseKey: string | null,
  headKey: string | null,
): SignatureState {
  if (loaded.errors && loaded.errors.length > 0) return "malformed";
  const manifest = loaded.manifest;
  if (!manifest) return "missing";
  if (typeof manifest.signature !== "string" || !manifest.signature) return "unsigned";
  const baseUsable = looksLikePublicKey(baseKey);
  const headUsable = looksLikePublicKey(headKey);
  if (baseKey && !baseUsable) return "unverifiable";
  const baseValid = baseUsable && verifyManifestSignature(manifest, baseKey as string);
  const headValid = headUsable && verifyManifestSignature(manifest, headKey as string);
  if (baseUsable) {
    if (baseValid) {
      // A cryptographically valid signature with a mismatched V2
      // `signingKeyId` must not be reported as valid.
      if (
        manifest.schemaVersion === 2 &&
        manifest.signingKeyId !== signingKeyIdFor(baseKey as string)
      ) {
        return "invalid";
      }
      return "valid";
    }
    if (headValid) return "untrusted-key";
    return "invalid";
  }
  if (headUsable && headValid) return "bootstrap";
  if (headUsable) return "invalid";
  return "unverifiable";
}

/**
 * Load the public manifests referenced by a PR and verify them against the
 * BASE-branch trust root (`baseRef`). When `baseRef` is omitted (tests, or a
 * payload without base info) the head key is used with state \"bootstrap\" —
 * callers should always pass the base SHA in production.
 */
export async function fetchIntents(
  github: GitHubClientLike,
  owner: string,
  repo: string,
  ref: string,
  commits: PullCommit[],
  ids: string[],
  baseRef?: string,
): Promise<IntentView[]> {
  if (ids.length === 0) return [];

  // The manifest path is deterministic per intent id.
  const loaded = new Map<string, LoadedManifest>();
  for (const id of ids) {
    const raw = await github.getFileContent(owner, repo, `.drift/public/intents/${id}.json`, ref);
    loaded.set(id, parseLoadedManifest(raw, id));
  }

  // Trust root: the BASE-branch public key (never the untrusted PR head key).
  const baseRefToUse = baseRef ?? ref;
  const baseKey = await readKey(github, owner, repo, baseRefToUse);
  // The head key is only used to DETECT a key replacement / rotation.
  const headKey = ref === baseRefToUse ? baseKey : await readKey(github, owner, repo, ref);

  const views: IntentView[] = [];
  for (const id of ids) {
    const entry = loaded.get(id) ?? { manifest: null, errors: null };
    const manifest = entry.manifest;
    const malformed = Boolean(entry.errors && entry.errors.length > 0);
    const state = signatureStateFor(entry, baseKey, headKey);
    views.push({
      id,
      authorType: manifest?.agent?.type ?? "unknown",
      authorId: manifest?.agent?.identifier ?? "unknown",
      model: manifest?.model ?? null,
      summary: manifest?.summary ?? `Drift intent ${id}`,
      verifyCmd: manifest?.verification ?? null,
      files: (manifest?.files ?? []).map((f) => ({
        path: f.path,
        mutationType: f.mutationType,
        summary: f.summary ?? null,
      })),
      signature: state === "valid",
      signatureState: state,
      missingManifest: manifest === null && !malformed,
      malformedManifest: malformed,
      ...(malformed && entry.errors && entry.errors.length > 0
        ? { manifestError: `${entry.errors[0]!.field}: ${entry.errors[0]!.message}` }
        : {}),
    });
  }
  return views;
}

// ---------------------------------------------------------------------------
// Public-provenance integrity audit (append-only rules, ADR-009)
// ---------------------------------------------------------------------------

const INTENT_FILE_RE = /^did_[0-9a-f]{32}\.json$/;

/**
 * Bounded PER-PR audit limits. These apply ONLY to public provenance files
 * CHANGED or INSPECTED by the current pull request — never to the repository's
 * accumulated history. A repository with a million unchanged historical
 * manifests must still allow an ordinary source-only PR without loading any
 * of them. The Action documents the same semantics in SECURITY.md.
 */
export const MAX_CHANGED_PUBLIC_FILES_PER_PR = 200;
export const MAX_TOTAL_CHANGED_PROVENANCE_BYTES_PER_PR = 50 * 1024 * 1024;

const PUBLIC_INTENTS_PREFIX = ".drift/public/intents/";

/** Extract the manifest id from a `.drift/public/intents/<id>.json` path. */
function manifestIdFromPath(path: string): string | null {
  const m = /^\.drift\/public\/intents\/(did_[0-9a-f]{32})\.json$/.exec(path);
  return m ? (m[1] as string) : null;
}

/**
 * Audit ONLY the public provenance CHANGED by this pull request — via the
 * paginated Pull Request Files API as the primary changed-path source. A PR
 * can tamper with existing provenance without adding any `Drift-Intent:`
 * trailer; that must be a FAILING condition, not invisible. Rules (ADR-009
 * append-only model):
 *
 *   added manifest     → orphan when NO PR commit references the id; the
 *                        introducing commit (the first PR commit where the
 *                        file exists) must carry exactly ONE matching
 *                        `Drift-Intent:` trailer (intro-mismatch otherwise);
 *                        the head content must be byte-identical to the
 *                        introduction content (added-then-modified =
 *                        `mutated` violation).
 *   modified manifest  → violation (append-only).
 *   deleted manifest   → violation (append-only).
 *   renamed manifest   → violation (append-only).
 *   trailer for an id whose manifest exists on the base branch → replay.
 *   one id referenced by >1 distinct PR commit → ambiguous association.
 *
 * Unchanged historical manifests are NEVER enumerated or compared: they are
 * not in the changed-files response and therefore cannot produce a violation.
 * Limits apply to changed files only; an incomplete changed-files listing
 * (pagination cap hit) is reported as a violation, never inferred as "no
 * public changes".
 */
export interface AuditScopeOptions {
  /** SHAs reachable from head but NOT from base (compare base...head) — a
   *  trailer reference is NEW when its referencing commit is in this set. */
  aheadShas?: Set<string>;
  /** True when the PR commit enumeration is provably incomplete — the audit
   *  must fail, never conclude from a partial commit list. */
  commitAuditIncomplete?: boolean;
  /** Expected changed-file count from PR metadata — when provided and the
   *  fetched changed-files listing has a different unique count, the audit
   *  fails closed instead of inferring "no public changes" from a partial
   *  listing. */
  expectedFiles?: number;
}

export async function auditProvenanceIntegrity(
  github: GitHubClientLike,
  owner: string,
  repo: string,
  prNumber: number,
  commits: PullCommit[],
  baseSha: string,
  headSha: string,
  opts: AuditScopeOptions = {},
): Promise<ProvenanceAudit> {
  const violations: ProvenanceAudit["violations"] = [];
  const replayIds: string[] = [];
  const ambiguousIds: string[] = [];

  // An INCOMPLETE commit enumeration can never support a trust conclusion:
  // a truncated list must not be treated as "no trailer". Fail closed.
  if (opts.commitAuditIncomplete) {
    violations.push({
      code: "incomplete-commit-audit",
      id: "(audit)",
      detail: "the pull-request commit listing is incomplete (endpoint cap or interrupted pagination) — the audit cannot conclude",
    });
    return { violations, replayIds, ambiguousIds };
  }

  // Which PR commits reference each id (atomic association requires exactly
  // ONE referencing commit).
  const refCommits = new Map<string, string[]>();
  for (const commit of commits) {
    for (const id of extractDriftIntentIds(commit.message)) {
      const list = refCommits.get(id) ?? [];
      list.push(commit.sha);
      refCommits.set(id, list);
    }
  }

  // PRIMARY SOURCE: the paginated PR changed-files listing. Incomplete
  // pagination must fail safely — a partial listing is never treated as "no
  // public changes".
  const { files, truncated } = await github.getPullFiles(owner, repo, prNumber);
  if (truncated) {
    violations.push({
      code: "modified",
      id: "(audit)",
      detail: "the changed-files listing is incomplete (pagination cap) — audit cannot conclude",
    });
    return { violations, replayIds, ambiguousIds };
  }
  // PR-metadata completeness: when the expected changed-file count is known
  // and differs from the fetched unique listing, the listing is incomplete —
  // fail closed rather than conclude "no public provenance changes".
  if (opts.expectedFiles !== undefined && opts.expectedFiles >= 0) {
    const uniqueFiles = new Set(files.map((f) => f.filename)).size;
    if (uniqueFiles !== opts.expectedFiles) {
      violations.push({
        code: "modified",
        id: "(audit)",
        detail: `the changed-files listing reports ${uniqueFiles} unique files but PR metadata reports ${opts.expectedFiles} — the listing is incomplete, audit cannot conclude`,
      });
      return { violations, replayIds, ambiguousIds };
    }
  }

  // Changed public-provenance paths only (key.pem is evaluated separately by
  // the trust-root change detection — it is not an integrity violation).
  const changed = files.filter(
    (f) => f.filename.startsWith(PUBLIC_INTENTS_PREFIX) || (f.previous_filename ?? "").startsWith(PUBLIC_INTENTS_PREFIX),
  );
  if (changed.length > MAX_CHANGED_PUBLIC_FILES_PER_PR) {
    violations.push({
      code: "modified",
      id: "(audit)",
      detail: `more than ${MAX_CHANGED_PUBLIC_FILES_PER_PR} public provenance files changed by this PR — bounded audit`,
    });
    return { violations, replayIds, ambiguousIds };
  }

  let totalChangedBytes = 0;
  for (const f of changed) {
    const id = manifestIdFromPath(f.filename);
    const oldId = manifestIdFromPath(f.previous_filename ?? "");
    const status = f.status;
    if (status === "renamed") {
      violations.push({
        code: "renamed",
        id: oldId ?? id ?? f.filename,
        detail: `${f.previous_filename ?? "?"} → ${f.filename}`,
      });
      continue;
    }
    if (!id) continue; // non-manifest public file (e.g. key.pem) — handled elsewhere
    const headRaw = await github.getFileContent(owner, repo, f.filename, headSha);
    if (headRaw !== null) totalChangedBytes += Buffer.byteLength(headRaw, "utf8");
    if (status === "added") {
      const refs = refCommits.get(id) ?? [];
      if (refs.length === 0) {
        violations.push({
          code: "orphan",
          id,
          detail: "new public manifest added without any Drift-Intent trailer on this PR",
        });
        continue;
      }
      if (refs.length > 1) {
        ambiguousIds.push(id);
        continue;
      }
      const introSha = await introductionCommit(github, owner, repo, f.filename, commits, headSha);
      if (!introSha) {
        violations.push({ code: "orphan", id, detail: "could not determine the manifest's introducing commit" });
        continue;
      }
      if (introSha !== refs[0]) {
        violations.push({
          code: "intro-mismatch",
          id,
          detail: `manifest introduced by ${introSha.slice(0, 7)} but its Drift-Intent trailer is on ${refs[0]!.slice(0, 7)} — the introducing commit must carry exactly one matching trailer`,
        });
        continue;
      }
      const introRaw = await github.getFileContent(owner, repo, f.filename, introSha);
      if (introRaw !== headRaw) {
        violations.push({
          code: "mutated",
          id,
          detail: "manifest was modified after it was introduced in the same pull request (added-then-modified)",
        });
      }
      continue;
    }
    if (status === "modified") {
      violations.push({
        code: "modified",
        id,
        detail: "an existing public manifest must be append-only (content changed on this PR)",
      });
      continue;
    }
    if (status === "deleted") {
      violations.push({ code: "deleted", id, detail: "an existing public manifest must not be deleted by a pull request" });
    }
  }
  if (totalChangedBytes > MAX_TOTAL_CHANGED_PROVENANCE_BYTES_PER_PR) {
    violations.push({
      code: "modified",
      id: "(audit)",
      detail: `total provenance content changed by this PR exceeds ${MAX_TOTAL_CHANGED_PROVENANCE_BYTES_PER_PR} bytes — bounded audit`,
    });
  }

  // Replay + trailer-without-manifest: every referenced id must have its
  // manifest either on the base branch (then this PR re-references an
  // existing intent = replay) or at the immutable PR head. A NEW trailer —
  // referenced by a commit that is ahead of base (in compare base...head) —
  // whose manifest exists NOWHERE is a hard violation: newly introduced
  // intents must carry their manifest in the same commit. Only a reference
  // carried in from base history (legacy pre-V2 intent) stays neutral.
  for (const id of refCommits.keys()) {
    const path = `.drift/public/intents/${id}.json`;
    const baseRaw = await github.getFileContent(owner, repo, path, baseSha);
    if (baseRaw !== null) {
      replayIds.push(id);
      continue;
    }
    const headRaw = await github.getFileContent(owner, repo, path, headSha);
    if (headRaw !== null) continue; // added manifest — validated by the entry loop
    const referencing = refCommits.get(id) ?? [];
    // A reference is NEW when its commit is ahead of base. When the caller
    // does not supply the ahead set at all, fail safe: treat references as
    // new (a hard violation) rather than silently classifying them as legacy.
    const newlyIntroduced =
      opts.aheadShas === undefined
        ? referencing.length > 0
        : referencing.some((sha) => opts.aheadShas!.has(sha));
    if (newlyIntroduced) {
      violations.push({
        code: "trailer-without-manifest",
        id,
        detail: "a new Drift-Intent trailer on this PR has no public manifest at the PR head — newly introduced intents must carry their manifest in the same commit",
      });
    }
  }

  return { violations, replayIds, ambiguousIds };
}

/**
 * The first PR commit (oldest first — GitHub returns `pulls/{n}/commits` in
 * chronological order) whose tree contains the manifest path. Used to verify
 * that the manifest was introduced by the same commit that carries its
 * `Drift-Intent:` trailer and that head content is byte-identical to the
 * introduced content. NEVER falls back to `headSha` as the introduction
 * commit: with a complete commit list, a manifest not found in any listed
 * commit is a violation (the caller reports it), never a silent guess.
 */
async function introductionCommit(
  github: GitHubClientLike,
  owner: string,
  repo: string,
  path: string,
  commits: PullCommit[],
  _headSha: string,
): Promise<string | null> {
  for (const commit of commits) {
    const raw = await github.getFileContent(owner, repo, path, commit.sha);
    if (raw !== null) return commit.sha;
  }
  return null;
}

async function readKey(
  github: GitHubClientLike,
  owner: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  const keyRaw = await github.getFileContent(owner, repo, ".drift/public/key.pem", ref);
  // ONLY a strictly-valid Ed25519 public key is usable verification material;
  // malformed / private / wrong-algorithm keys return null (unverifiable) and
  // the key-change detection flags them as a failure state separately.
  if (keyRaw && tryParseTrustRoot(keyRaw).state === "valid") return keyRaw.trim();
  return null;
}

/** Verify a manifest's Ed25519 signature against a PEM public key. */
function verifyManifestSignature(manifest: PublicIntentView, publicKey: string): boolean {
  const { signature, ...unsigned } = manifest;
  if (!signature || !unsigned.id) return false;
  try {
    return verifyPayload(canonicalJson(unsigned), publicKey, signature);
  } catch {
    return false;
  }
}
