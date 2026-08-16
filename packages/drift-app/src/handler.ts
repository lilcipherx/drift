/**
 * pull_request webhook handler (PRD §16.2).
 *
 * On `opened`/`synchronize`/`reopened`:
 *   1. verify the webhook HMAC — FAIL CLOSED: production requires a webhook
 *      secret; only an explicit `DRIFT_APP_INSECURE_DEV_MODE=true` allows
 *      unsigned requests (loudly warned, local development only);
 *   2. evaluate the trust root (base vs head `.drift/public/key.pem`) BEFORE
 *      any \"no intents\" early return — a key-only PR must never be invisible;
 *   3. read `Drift-Intent:` trailers from the PR commits and hydrate strictly
 *      validated public manifests (`.drift/public/intents/`);
 *   4. derive the Check Run conclusion from the shared policy
 *      (`deriveProvenanceConclusion`) — never unconditional success;
 *   5. post/update the summary comment, updating ONLY ownership-verified
 *      Drift comments (spoofed user-authored markers are never touched).
 *
 * Private data (prompts, `objects/`, `drift.db`) is never read or rendered.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { GitHubClientLike, IssueComment } from "./github.js";
import { auditProvenanceIntegrity, extractIntentIds, fetchIntents } from "./intents.js";
import { summarizeIntents } from "./summarize.js";
import {
  deriveProvenanceConclusion,
  evaluateKeyChange,
  findOwnedDriftComment,
  type KeyChange,
} from "./trust.js";

export interface WebhookDeps {
  github: GitHubClientLike;
  /** HMAC webhook secret (X-Hub-Signature-256). Required in production. */
  webhookSecret?: string;
  /** Explicit insecure development mode (must be exactly \"true\"). */
  insecureDevMode?: boolean;
  /** Disable check-run creation (comment-only mode). */
  checkRun?: boolean;
  /** Build the summary without writing anything (dev --dry-run). */
  readOnly?: boolean;
  /**
   * The configured Drift GitHub App id, used for EXACT comment ownership
   * matching (performed_via_github_app.id must equal this). When absent, no
   * comment is treated as owned (fail-safe: never PATCH a possibly-foreign
   * comment).
   */
  appId?: string;
}

export interface WebhookResult {
  handled: boolean;
  action:
    | "commented"
    | "updated"
    | "no-intents"
    | "key-change"
    | "skipped"
    | "error"
    | "dry-run";
  commentBody?: string;
  intentsFound: number;
  conclusion?: "success" | "neutral" | "failure";
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
  // Expected Drift App id for exact comment ownership (never an arbitrary
  // positive id): the deps override wins, else the client's configured id.
  const expectedAppId = deps.appId || github.getAppId?.() || null;

  // --- Fail-closed webhook authentication --------------------------------
  // Production App mode REQUIRES a webhook secret: without it anyone can
  // forge pull_request deliveries. Unsigned requests are accepted ONLY in an
  // explicit insecure development mode (DRIFT_APP_INSECURE_DEV_MODE=true),
  // which is loud and documented as local-development-only.
  if (!deps.webhookSecret) {
    if (deps.insecureDevMode !== true) {
      return {
        handled: true,
        action: "error",
        intentsFound: 0,
        error:
          "webhook secret missing — set GITHUB_WEBHOOK_SECRET (production requires authenticated webhooks; for local development set DRIFT_APP_INSECURE_DEV_MODE=true explicitly)",
        retryable: false,
      };
    }
    console.error(
      "[drift-app] ⚠ DRIFT_APP_INSECURE_DEV_MODE=true — webhook signatures are NOT verified. Local development only; never enable this in production.",
    );
  } else if (!verifyWebhookSignature(event.rawBody, event.signature, deps.webhookSecret)) {
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

  const pr = payload.pull_request as {
    number?: number;
    head?: { sha?: string };
    base?: { sha?: string };
    title?: string;
  } | undefined;
  const repo = payload.repository as { name?: string; owner?: { login?: string } } | undefined;
  const installation = payload.installation as { id?: number } | undefined;
  const owner = repo?.owner?.login;
  const repoName = repo?.name;
  const prNumber = pr?.number;
  const headSha = pr?.head?.sha;
  const baseSha = pr?.base?.sha;

  if (!owner || !repoName || !prNumber || !headSha) {
    return { handled: true, action: "error", intentsFound: 0, error: "malformed pull_request payload", retryable: false };
  }
  if (!installation?.id) {
    return { handled: true, action: "error", intentsFound: 0, error: "no installation id in payload", retryable: false };
  }

  try {
    github.setInstallation(installation.id);

    // --- Trust-root evaluation FIRST ---------------------------------------
    // A key-only PR (replaces .drift/public/key.pem with zero intents) must
    // still produce a visible warning + blocking check run. Never exit
    // through the no-intents path before evaluating the key.
    const baseKey = await github.getFileContent(owner, repoName, ".drift/public/key.pem", baseSha ?? headSha);
    const headKey = await github.getFileContent(owner, repoName, ".drift/public/key.pem", headSha);
    const keyChange: KeyChange = evaluateKeyChange(baseKey, headKey);

    const commits = await github.getPullCommits(owner, repoName, prNumber);
    const ids = extractIntentIds(commits);

    // Integrity audit runs BEFORE any early return: a PR can tamper with
    // existing public manifests (modified/deleted/renamed/orphan/replay)
    // while carrying zero ordinary trailers, and that must still fail the
    // check — never silently green.
    const audit = await auditProvenanceIntegrity(
      github,
      owner,
      repoName,
      prNumber,
      commits,
      baseSha ?? headSha,
      headSha,
    );
    const integrityBroken =
      audit.violations.length > 0 || audit.replayIds.length > 0 || audit.ambiguousIds.length > 0;

    // A key-only PR: blocking warning comment + failing check run, no intents
    // needed. Integrity violations with zero intents also surface here.
    if (ids.length === 0) {
      const conclusion = deriveProvenanceConclusion({ intents: [], keyChange, audit });
      if (keyChange === "replaced" || keyChange === "removed" || keyChange === "bootstrap" || integrityBroken) {
        const commentBody = summarizeIntents({
          owner,
          repo: repoName,
          prNumber,
          prTitle: pr?.title ?? "",
          intents: [],
          keyChange: keyChange === "replaced" || keyChange === "removed" ? keyChange : undefined,
          audit,
        });
        if (!deps.readOnly) {
          // Check Run first, comment second — a comment failure must never
          // suppress the machine-readable trust result (issue 9).
          const checkError = await createCheckRunSafe(github, owner, repoName, headSha, conclusion, commentBody, deps.checkRun !== false);
          let writeError: string | null = null;
          try {
            await writeOwnedComment(github, owner, repoName, prNumber, commentBody, expectedAppId);
          } catch (err) {
            writeError = err instanceof Error ? err.message : String(err);
          }
          if (checkError && writeError) {
            throw new Error(`check run failed (${checkError}); comment failed (${writeError})`);
          }
        }
        return {
          handled: true,
          action: "key-change",
          commentBody,
          intentsFound: 0,
          conclusion: conclusion.conclusion,
          error: undefined,
        };
      }
      return { handled: true, action: "no-intents", intentsFound: 0 };
    }

    // Hydrate strictly validated public manifests + per-intent trust states.
    const intents = await fetchIntents(github, owner, repoName, headSha, commits, ids, baseSha);

    const commentBody = summarizeIntents({
      owner,
      repo: repoName,
      prNumber,
      prTitle: pr?.title ?? "",
      intents,
      ...(keyChange === "replaced" || keyChange === "removed" ? { keyChange } : {}),
      audit,
    });

    const conclusion = deriveProvenanceConclusion({ intents, keyChange, audit });

    // dev --dry-run: build everything but write nothing.
    if (deps.readOnly) {
      return { handled: true, action: "dry-run", commentBody, intentsFound: intents.length, conclusion: conclusion.conclusion };
    }

    // Check Run creation is INDEPENDENT of the comment: a failure to list,
    // post or update the comment must not prevent the check result (and a
    // check-run failure must not suppress the comment).
    const checkError = await createCheckRunSafe(github, owner, repoName, headSha, conclusion, commentBody, deps.checkRun !== false);
    let writeAction: "updated" | "commented" | null = null;
    let writeError: string | null = null;
    try {
      writeAction = await writeOwnedComment(github, owner, repoName, prNumber, commentBody, expectedAppId);
    } catch (err) {
      writeError = err instanceof Error ? err.message : String(err);
    }
    if (checkError && writeError) {
      throw new Error(`check run failed (${checkError}); comment failed (${writeError})`);
    }
    return {
      handled: true,
      action: writeAction ?? "error",
      commentBody,
      intentsFound: intents.length,
      conclusion: conclusion.conclusion,
      ...(writeError ? { error: `comment failed: ${writeError}` } : {}),
      ...(checkError ? { error: `check run failed: ${checkError}` } : {}),
    };
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

/**
 * Create the Check Run with independent error handling (never throws): the
 * trust result is the primary machine-readable outcome and must survive a
 * comment/API hiccup. Returns the error message, or null on success.
 */
async function createCheckRunSafe(
  github: GitHubClientLike,
  owner: string,
  repo: string,
  headSha: string,
  conclusion: { conclusion: "success" | "neutral" | "failure"; title: string; summary: string },
  commentBody: string,
  enabled: boolean,
): Promise<string | null> {
  if (!enabled) return null;
  try {
    await github.createCheckRun(owner, repo, {
      name: "Drift intent check",
      headSha,
      conclusion: conclusion.conclusion,
      title: conclusion.title,
      summary: `${conclusion.summary}\n\n${commentBody}`,
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Post the summary, or update the canonical OWNED Drift comment in place.
 * Spoofed user-authored markers are left untouched (ownership is verified by
 * GitHub-attested authorship — github-actions[bot] login or a real
 * performed_via_github_app.id — never by marker presence alone).
 * Returns "updated" when an owned comment was PATCHed, else "commented".
 */
async function writeOwnedComment(
  github: GitHubClientLike,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  expectedAppId: string | null | undefined,
): Promise<"updated" | "commented"> {
  const comments = (await github.listIssueComments(owner, repo, prNumber)) as (IssueComment & {
    user?: { login?: string; type?: string } | null;
    performed_via_github_app?: { id?: number } | null;
  })[];
  const existing = findOwnedDriftComment(comments, expectedAppId);
  if (existing) {
    if (existing.duplicates > 0) {
      console.error(
        `[drift-app] ⚠ found ${existing.duplicates + 1} genuine Drift comments on PR #${prNumber} — updating the oldest (id ${existing.id}), leaving the others untouched.`,
      );
    }
    await github.updateComment(owner, repo, existing.id, body);
    return "updated";
  }
  await github.postComment(owner, repo, prNumber, body);
  return "commented";
}
