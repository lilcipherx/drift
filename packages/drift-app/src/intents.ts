/**
 * Read `Drift-Intent: <id>` trailers from pull request commits and hydrate the
 * intent objects from `.drift/objects/` at the PR head (PRD §16.2).
 */

import { deriveMasterKey, decryptAesGcm, isEncrypted } from "@drift/core";
import type { GitHubClientLike, PullCommit } from "./github.js";

const TRAILER_RE = /Drift-Intent:\s*(did_[0-9a-f]{32})/g;

export interface IntentFileView {
  path: string;
  mutationType: string;
  summary: string | null;
}

export interface IntentView {
  id: string;
  authorType: string;
  authorId: string;
  model: string | null;
  prompt: string;
  encryptedPrompt: boolean;
  verifyCmd: string | null;
  files: IntentFileView[];
  signature: boolean;
}

/** Extract unique intent ids referenced by a set of commits (order preserved). */
export function extractIntentIds(commits: PullCommit[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const commit of commits) {
    TRAILER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TRAILER_RE.exec(commit.message)) !== null) {
      const id = m[1]!;
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * Decrypt an `encv1:` prompt when DRIFT_MASTER_KEY is available. `aad` must
 * match the intent id the payload was bound to at realize time.
 */
export function decryptPrompt(
  prompt: string,
  masterKeyEnv?: string,
  aad?: string,
): { prompt: string; encrypted: boolean } {
  if (!isEncrypted(prompt)) return { prompt, encrypted: false };
  if (!masterKeyEnv) return { prompt: "🔒 [encrypted]", encrypted: true };
  try {
    return { prompt: decryptAesGcm(prompt, deriveMasterKey(masterKeyEnv), aad), encrypted: true };
  } catch {
    return { prompt: "🔒 [encrypted: invalid key]", encrypted: true };
  }
}

/**
 * Load the intent objects referenced by a PR. Falls back to the commit
 * message subject as the prompt when the object is missing (e.g. `.drift`
 * not committed).
 */
interface LoadedObject {
  id: string;
  prompt?: string;
  author?: { type?: string; identifier?: string; model?: string };
  astDelta?: { filePath?: string; type?: string; summary?: string }[];
  verifyCmd?: string;
  signature?: string;
}

/**
 * Load the intent objects referenced by a PR. Falls back to the commit
 * message subject as the prompt when the object is missing (e.g. `.drift`
 * not committed).
 */
export async function fetchIntents(
  github: GitHubClientLike,
  owner: string,
  repo: string,
  ref: string,
  commits: PullCommit[],
  ids: string[],
  masterKeyEnv?: string,
): Promise<IntentView[]> {
  if (ids.length === 0) return [];

  // Fetch `.drift/objects/**` until every referenced intent is found (the
  // object path is content-addressed, so it cannot be derived from the id).
  const loaded = new Map<string, LoadedObject>();
  const paths = await github.getObjectPaths(owner, repo, ref);
  for (const path of paths) {
    const raw = await github.getFileContent(owner, repo, path, ref);
    if (!raw) continue;
    let obj: LoadedObject;
    try {
      obj = JSON.parse(raw) as LoadedObject;
    } catch {
      continue;
    }
    if (obj.id && ids.includes(obj.id)) loaded.set(obj.id, obj);
  }

  // subject fallback: map each intent id to the commit that introduced it
  const subjectByIntent = new Map<string, string>();
  for (const commit of commits) {
    TRAILER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TRAILER_RE.exec(commit.message)) !== null) {
      if (!subjectByIntent.has(m[1]!)) {
        subjectByIntent.set(m[1]!, commit.message.split("\n")[0] ?? "");
      }
    }
  }

  const views: IntentView[] = [];
  for (const id of ids) {
    const obj = loaded.get(id);
    const rawPrompt = obj?.prompt ?? subjectByIntent.get(id) ?? "";
    const decrypted = decryptPrompt(rawPrompt, masterKeyEnv, id);
    views.push({
      id,
      authorType: obj?.author?.type ?? "unknown",
      authorId: obj?.author?.identifier ?? "unknown",
      model: obj?.author?.model ?? null,
      prompt: decrypted.prompt,
      encryptedPrompt: decrypted.encrypted,
      verifyCmd: obj?.verifyCmd ?? null,
      files: (obj?.astDelta ?? []).map((d) => ({
        path: d.filePath ?? "?",
        mutationType: d.type ?? "MODIFIED",
        summary: d.summary ?? null,
      })),
      signature: Boolean(obj?.signature),
    });
  }
  return views;
}
