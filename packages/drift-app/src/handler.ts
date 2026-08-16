/**
 * pull_request webhook handler (PRD §16.2).
 *
 * On `opened`/`synchronize`/`reopened`:
 *   1. read `Drift-Intent` trailers from the PR commits;
 *   2. hydrate intent objects from `.drift/objects/` at the PR head;
 *   3. post a semantic summary comment and a check run.
 *
 * Idempotent: the summary embeds an invisible `SUMMARY_MARKER`; if a Drift
 * comment already exists on the PR it is updated in place, so repeated
 * deliveries (GitHub webhook retries, `synchronize` pushes) never stack
 * duplicate comments.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { GitHubClientLike } from "./github.js";
import { extractIntentIds, fetchIntents } from "./intents.js";
import { summarizeIntents, SUMMARY_MARKER } from "./summarize.js";

export interface WebhookDeps {
  github: GitHubClientLike;
  /** HMAC webhook secret (X-Hub-Signature-256). Undefined ⇒ skip verification. */
  webhookSecret?: string;
  /** Disable check-run creation (comment-only mode). */
  checkRun?: boolean;
  /** Build the summary without writing anything (dev --dry-run). */
  readOnly?: boolean;
}

export interface WebhookResult {
  handled: boolean;
  action: "commented" | "updated" | "no-intents" | "skipped" | "error" | "dry-run";
  commentBody?: string;
  intentsFound: number;
  error?: string;
  /** False for client-side errors (GitHub must not retry). */
  retryable?: boolean;
}

export interface WebhookEvent {
  event: string; // X-GitHub-Event
  signature?: string; // X-Hub-Signature-256
  payload: Record<string, unknown>;
  rawBody: string;
}

export function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const PR_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export async function handleWebhook(event: WebhookEvent, deps: WebhookDeps): Promise<WebhookResult> {
  const { github } = deps;

  if (deps.webhookSecret && !verifyWebhookSignature(event.rawBody, event.signature, deps.webhookSecret)) {
    return { handled: true, action: "error", intentsFound: 0, error: "invalid webhook signature", retryable: false };
  }

  if (event.event !== "pull_request") {
    return { handled: true, action: "skipped", intentsFound: 0 };
  }

  const payload = event.payload;
  const action = payload.action as string | undefined;
  if (!action || !PR_ACTIONS.has(action)) {
    return { handled: true, action: "skipped", intentsFound: 0 };
  }

  const pr = payload.pull_request as { number?: number; head?: { sha?: string }; title?: string } | undefined;
  const repo = payload.repository as { name?: string; owner?: { login?: string } } | undefined;
  const installation = payload.installation as { id?: number } | undefined;
  const owner = repo?.owner?.login;
  const repoName = repo?.name;
  const prNumber = pr?.number;
  const headSha = pr?.head?.sha;

  if (!owner || !repoName || !prNumber || !headSha) {
    return { handled: true, action: "error", intentsFound: 0, error: "malformed pull_request payload", retryable: false };
  }
  if (!installation?.id) {
    return { handled: true, action: "error", intentsFound: 0, error: "no installation id in payload", retryable: false };
  }

  try {
    github.setInstallation(installation.id);
    const commits = await github.getPullCommits(owner, repoName, prNumber);
    const ids = extractIntentIds(commits);
    if (ids.length === 0) {
      return { handled: true, action: "no-intents", intentsFound: 0 };
    }

    // Trust root: verify head-branch manifests against the BASE-branch public
    // key. The PR head key is untrusted until a controlled rotation.
    const baseSha = (payload.pull_request as { base?: { sha?: string } } | undefined)?.base?.sha;
    const intents = await fetchIntents(github, owner, repoName, headSha, commits, ids, baseSha);

    let commentBody = summarizeIntents({
      owner,
      repo: repoName,
      prNumber,
      prTitle: pr?.title ?? "",
      intents,
    });

    // A PR that replaces .drift/public/key.pem is never silently trusted.
    if (baseSha) {
      const baseKey = await github.getFileContent(owner, repoName, ".drift/public/key.pem", baseSha);
      const headKey = await github.getFileContent(owner, repoName, ".drift/public/key.pem", headSha);
      const keyChanged =
        Boolean(baseKey) && Boolean(headKey) && (baseKey as string).trim() !== (headKey as string).trim();
      if (keyChanged) {
        commentBody =
          "⚠ **Warning: this pull request changes the Drift public signing key (.drift/public/key.pem).** New provenance on this PR is marked unverified until a controlled key-rotation process is approved.\n\n" +
          commentBody;
      }
    }

    // Idempotent write: update the existing Drift comment when present,
    // otherwise post a new one.
    // dev --dry-run: build the summary but write nothing (no comment, no check
    // run, and no comment listing — the summary needs only commits + objects).
    if (deps.readOnly) {
      return { handled: true, action: "dry-run", commentBody, intentsFound: intents.length };
    }
    const comments = await github.listIssueComments(owner, repoName, prNumber);
    const existing = comments.find((c) => c.body.includes(SUMMARY_MARKER));
    let action: "commented" | "updated";
    if (existing) {
      await github.updateComment(owner, repoName, existing.id, commentBody);
      action = "updated";
    } else {
      await github.postComment(owner, repoName, prNumber, commentBody);
      action = "commented";
    }

    if (deps.checkRun !== false) {
      await github.createCheckRun(owner, repoName, {
        name: "Drift intent check",
        headSha,
        conclusion: "success",
        title: `${intents.length} intent${intents.length === 1 ? "" : "s"} summarized`,
        summary: commentBody,
      });
    }

    return { handled: true, action, commentBody, intentsFound: intents.length };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Permanent GitHub API errors (4xx: repo deleted, bad permissions, invalid
    // installation) will never succeed on retry — ack with 200 so GitHub stops
    // redelivering. Only transient failures (network, 5xx) should be retried.
    const status = /failed: (\d{3})/.exec(error)?.[1];
    const code = status ? Number(status) : 0;
    // 429 (rate limit) is transient even though it is < 500.
    const retryable = !status || code === 429 || code >= 500;
    return { handled: true, action: "error", intentsFound: 0, error, retryable };
  }
}
