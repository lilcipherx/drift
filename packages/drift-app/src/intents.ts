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
 * unverified, never silently trusted.
 */

import { canonicalJson, extractDriftIntentIds, verifyPayload } from "@drift/core";
import type { GitHubClientLike, PullCommit } from "./github.js";

export interface IntentFileView {
  path: string;
  mutationType: string;
  summary: string | null;
}

/**
 * Signature/trust state of a manifest against the base-branch trust root:
 *   valid           — verifies against the base key.
 *   invalid         — a signature exists but does not verify against base/head.
 *   unsigned        — no signature recorded.
 *   unverifiable    — no verification material available.
 *   untrusted-key   — verifies only against a PR-replaced key (rotation).
 *   bootstrap       — base branch has no Drift key (initial adoption).
 *   missing         — no manifest found.
 */
export type SignatureState =
  | "valid"
  | "invalid"
  | "unsigned"
  | "unverifiable"
  | "untrusted-key"
  | "bootstrap"
  | "missing";

export interface IntentView {
  id: string;
  authorType: string;
  authorId: string;
  model: string | null;
  /**
   * Safe public summary — the ONLY prompt-derived text ever rendered. When a
   * manifest is missing, a generic non-prompt fallback (`Drift intent <id>`)
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

interface LoadedManifest {
  id?: string;
  summary?: string;
  model?: string;
  agent?: { type?: string; identifier?: string };
  verification?: string;
  files?: { path?: string; mutationType?: string; summary?: string }[];
  signature?: string;
}

/**
 * Resolve the signature/trust state of a manifest against the trusted base
 * key and the (untrusted) PR-head key.
 */
function signatureStateFor(
  manifest: LoadedManifest | null,
  baseKey: string | null,
  headKey: string | null,
): SignatureState {
  if (!manifest) return "missing";
  if (!manifest.signature) return "unsigned";
  if (!baseKey && !headKey) return "unverifiable";
  if (baseKey && verifyManifestSignature(manifest, baseKey)) return "valid";
  if (headKey && verifyManifestSignature(manifest, headKey)) {
    return baseKey ? "untrusted-key" : "bootstrap";
  }
  if (!baseKey) return "bootstrap";
  return "invalid";
}

/**
 * Load the public manifests referenced by a PR and verify them against the
 * BASE-branch trust root (`baseRef`). When `baseRef` is omitted (tests, or a
 * payload without base info) the head key is used with state "bootstrap" —
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
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as LoadedManifest;
      if (parsed && parsed.id === id) loaded.set(id, parsed);
    } catch {
      // malformed manifest — treated as missing (generic fallback below)
    }
  }

  // Trust root: the BASE-branch public key (never the untrusted PR head key).
  const baseRefToUse = baseRef ?? ref;
  const baseKey = await readKey(github, owner, repo, baseRefToUse);
  // The head key is only used to DETECT a key replacement / rotation.
  const headKey = ref === baseRefToUse ? baseKey : await readKey(github, owner, repo, ref);

  const views: IntentView[] = [];
  for (const id of ids) {
    const manifest = loaded.get(id) ?? null;
    const state = signatureStateFor(manifest, baseKey, headKey);
    views.push({
      id,
      authorType: manifest?.agent?.type ?? "unknown",
      authorId: manifest?.agent?.identifier ?? "unknown",
      model: manifest?.model ?? null,
      summary: manifest?.summary ?? `Drift intent ${id}`,
      verifyCmd: manifest?.verification ?? null,
      files: (manifest?.files ?? []).map((f) => ({
        path: f.path ?? "?",
        mutationType: f.mutationType ?? "MODIFIED",
        summary: f.summary ?? null,
      })),
      signature: state === "valid",
      signatureState: state,
      missingManifest: manifest === null,
    });
  }
  return views;
}

async function readKey(
  github: GitHubClientLike,
  owner: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  const keyRaw = await github.getFileContent(owner, repo, ".drift/public/key.pem", ref);
  if (keyRaw && keyRaw.includes("PUBLIC KEY")) return keyRaw.trim();
  return null;
}

/** Verify a manifest's Ed25519 signature against a PEM public key. */
function verifyManifestSignature(
  manifest: LoadedManifest,
  publicKey: string,
): boolean {
  const { signature, ...unsigned } = manifest;
  if (!signature || !unsigned.id) return false;
  try {
    return verifyPayload(canonicalJson(unsigned), publicKey, signature);
  } catch {
    return false;
  }
}
