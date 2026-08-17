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
import { RateLimitError, type GitHubClientLike, type IssueComment } from "./github.js";
import { auditProvenanceIntegrity, extractIntentIds, fetchIntents } from "./intents.js";
import { summarizeIntents } from "./summarize.js";
import {
  deriveProvenanceConclusion,
  evaluateKeyChange,
  evaluateKeyringChangeState,
  findOwnedDriftComment,
  type KeyChange,
  type KeyringChangeState,
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
    | "stale"
    | "error"
    | "dry-run";
  commentBody?: string;
  intentsFound: number;
  conclusion?: "success" | "neutral" | "failure";
  error?: string;
  /** False for client-side errors (GitHub must not retry). */
  retryable?: boolean;
  /** Client-provided retry hint (GitHub Retry-After for rate limits, ms). */
  retryAfterMs?: number;
  /** Structured Check Run + comment write outcomes for this delivery. */
  writeResult?: GitHubWriteResult;
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
    // through the no-intents path before evaluating the key. Key state uses
    // the SHARED strict parser: malformed bootstrap/replacement/base roots
    // are explicit failure states, never a fallback identity.
    const prInfo = await github.getPullRequest(owner, repoName, prNumber);
    // --- Snapshot consistency (stale-delivery guard) ------------------------
    // One audit must use one immutable PR snapshot. The payload carries the
    // head SHA as it was WHEN GITHUB DELIVERED the event; if the PR has moved
    // on (a newer push/synchronize arrived while this delivery was queued),
    // the fetched metadata and the payload head would disagree and mixing
    // them could produce a trust conclusion for a snapshot that never
    // existed. Fail closed: skip the stale delivery WITHOUT retrying — the
    // superseding synchronize delivery audits the current head. `getPullCommits`
    // and every content read below use the API's current view, so the guard
    // must pass BEFORE any of them run.
    if (prInfo.headSha && headSha && prInfo.headSha !== headSha) {
      return {
        handled: true,
        action: "stale",
        intentsFound: 0,
        error: `stale delivery: payload head ${headSha.slice(0, 7)} differs from the current PR head ${prInfo.headSha.slice(0, 7)} — a newer synchronize delivery will audit the current snapshot`,
        retryable: false,
      };
    }
    const effectiveBaseSha = baseSha || prInfo.baseSha || headSha;
    const effectiveHeadSha = headSha || prInfo.headSha;
    const baseKey = await github.getFileContent(owner, repoName, ".drift/public/key.pem", effectiveBaseSha);
    const headKey = await github.getFileContent(owner, repoName, ".drift/public/key.pem", effectiveHeadSha);
    const keyChange: KeyChange = evaluateKeyChange(baseKey, headKey);
    // Multi-signer keyring: the trust set is append-only. A PR may only EXTEND
    // the audit log (signed add/revoke/remove); deleting, editing, or
    // replacing the history fails the trust audit (see trust.ts).
    const baseKeyring = await github.getFileContent(owner, repoName, ".drift/public/keyring.json", effectiveBaseSha);
    const headKeyring = await github.getFileContent(owner, repoName, ".drift/public/keyring.json", effectiveHeadSha);
    const keyringChange: KeyringChangeState = evaluateKeyringChangeState(baseKeyring, headKeyring, baseKey, headKey);

    // Commit enumeration WITH completeness proof: the App must never conclude
    // trust from a truncated commit list (the REST endpoint caps at 250).
    const commitCollection = await github.getPullCommits(owner, repoName, prNumber);
    const commits = commitCollection.commits;
    const ids = extractIntentIds(commits);
    // Commits reachable from head but NOT from base — a trailer reference is
    // NEW when its commit is ahead of base; otherwise it is legacy history.
    const aheadShas = new Set(
      await github.getCompareCommits(owner, repoName, effectiveBaseSha, effectiveHeadSha),
    );

    // Integrity audit runs BEFORE any early return: a PR can tamper with
    // existing public manifests (modified/deleted/renamed/orphan/replay) or
    // introduce a trailer without its manifest, while carrying zero ordinary
    // trailers — that must still fail the check, never silently green.
    const audit = await auditProvenanceIntegrity(
      github,
      owner,
      repoName,
      prNumber,
      commits,
      effectiveBaseSha,
      effectiveHeadSha,
      {
        aheadShas,
        commitAuditIncomplete: !commitCollection.complete,
        expectedFiles: prInfo.changedFiles,
      },
    );
    const integrityBroken =
      audit.violations.length > 0 || audit.replayIds.length > 0 || audit.ambiguousIds.length > 0;

    // A key-only PR: blocking warning comment + failing check run, no intents
    // needed. Integrity violations with zero intents also surface here. Any
    // non-trivial key state (bootstrap, replaced, removed, malformed-*,
    // base-malformed) is surfaced — only none/unchanged stays silent.
    if (ids.length === 0) {
      const conclusion = deriveProvenanceConclusion({ intents: [], keyChange, keyringChange, audit });
      const KEYRING_FAILING = new Set(["replaced", "removed", "malformed-bootstrap", "malformed-replacement", "base-malformed"]);
      const keyVisible =
        (keyChange !== "none" && keyChange !== "unchanged") ||
        (keyringChange !== "none" && keyringChange !== "unchanged" && keyringChange !== "extended");
      if (keyVisible || integrityBroken) {
        const commentBody = summarizeIntents({
          owner,
          repo: repoName,
          prNumber,
          prTitle: pr?.title ?? "",
          intents: [],
          keyChange:
            keyChange === "replaced" ||
            keyChange === "removed" ||
            keyChange === "malformed-bootstrap" ||
            keyChange === "malformed-replacement" ||
            keyChange === "base-malformed"
              ? keyChange
              : undefined,
          audit,
        });
        if (deps.readOnly) {
          return { handled: true, action: "dry-run", commentBody, intentsFound: 0, conclusion: conclusion.conclusion };
        }
        // Check Run first, comment second — a comment failure must never
        // suppress the machine-readable trust result (issue 9); a check-run
        // failure must never be hidden by a successful comment.
        const writeResult: GitHubWriteResult = {
          checkRun: await createCheckRunSafe(github, owner, repoName, effectiveHeadSha, conclusion, commentBody, deps.checkRun !== false),
          comment: await writeOwnedCommentSafe(github, owner, repoName, prNumber, commentBody, expectedAppId),
        };
        const writeError = applyWriteResultPolicy(writeResult);
        return {
          handled: true,
          action: writeError ? "error" : "key-change",
          commentBody,
          intentsFound: 0,
          conclusion: conclusion.conclusion,
          ...(writeError ? { error: writeError.message, retryable: writeError.retryable } : {}),
          writeResult,
        };
      }
      return { handled: true, action: "no-intents", intentsFound: 0 };
    }

    // Hydrate strictly validated public manifests + per-intent trust states.
    const intents = await fetchIntents(github, owner, repoName, effectiveHeadSha, commits, ids, effectiveBaseSha);

    const commentBody = summarizeIntents({
      owner,
      repo: repoName,
      prNumber,
      prTitle: pr?.title ?? "",
      intents,
      ...(keyChange === "replaced" || keyChange === "removed" ? { keyChange } : {}),
      audit,
    });
    const conclusion = deriveProvenanceConclusion({ intents, keyChange, keyringChange, audit });

    // dev --dry-run: build everything but write nothing.
    if (deps.readOnly) {
      return { handled: true, action: "dry-run", commentBody, intentsFound: intents.length, conclusion: conclusion.conclusion };
    }

    // The Check Run is the PRIMARY machine-readable trust result: a comment
    // failure never suppresses it, and a check-run failure is never hidden by
    // a successful comment (a transient check failure makes the webhook
    // retryable so GitHub redelivers).
    const writeResult: GitHubWriteResult = {
      checkRun: await createCheckRunSafe(github, owner, repoName, effectiveHeadSha, conclusion, commentBody, deps.checkRun !== false),
      comment: await writeOwnedCommentSafe(github, owner, repoName, prNumber, commentBody, expectedAppId),
    };
    const writeError = applyWriteResultPolicy(writeResult);
    const commentAction =
      writeResult.comment.state === "success" ? writeResult.comment.action : "error";
    return {
      handled: true,
      action: writeError ? "error" : commentAction,
      commentBody,
      intentsFound: intents.length,
      conclusion: conclusion.conclusion,
      ...(writeError ? { error: writeError.message, retryable: writeError.retryable } : {}),
      writeResult,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // RateLimitError is the client's explicit transient signal: BOTH 429 and
    // GitHub's secondary rate limit (403 WITH Retry-After). A bare 403 without
    // Retry-After is a permanent permission error. Distinguishing the two is
    // critical: misclassifying a secondary rate limit as permanent drops a
    // delivery that GitHub would otherwise accept on retry.
    if (err instanceof RateLimitError) {
      return {
        handled: true,
        action: "error",
        intentsFound: 0,
        error,
        retryable: true,
        retryAfterMs: err.retryAfterMs,
      };
    }
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
 * Structured write outcomes for one webhook delivery. The Check Run is the
 * PRIMARY machine-readable trust result: a failed check run must never be
 * hidden by a successful comment, and vice versa. Transient API failures
 * (network/5xx/429) are `retryable` — the webhook then returns 500 so GitHub
 * redelivers — while permanent 4xx failures are acknowledged to stop retries.
 */
export type GitHubWriteResult = {
  checkRun:
    | { state: "success"; id: number }
    | { state: "skipped"; reason: string }
    | { state: "failed"; retryable: boolean; status?: number };
  comment:
    | { state: "success"; id: number; action: "updated" | "commented" }
    | { state: "skipped"; reason: string }
    | { state: "failed"; retryable: boolean; status?: number };
};

/** Extract { retryable, status } from a GitHub API error message. */
function failureClass(message: string): { retryable: boolean; status?: number } {
  const status = /failed: (\d{3})/.exec(message)?.[1];
  const code = status ? Number(status) : 0;
  // 429 (rate limit) is transient even though it is < 500.
  return { retryable: !status || code === 429 || code >= 500, status: code || undefined };
}

/**
 * Apply the write policy and produce the handler-level outcome:
 *  - check failed + comment failed   → error (retryable if either is)
 *  - check failed + comment ok       → error (retryable when transient — a
 *    successful comment must never hide a failed Check Run)
 *  - check ok + comment failed       → error (retryable when transient)
 *  - both ok / skipped               → null (no error)
 */
function applyWriteResultPolicy(
  writeResult: GitHubWriteResult,
): { message: string; retryable: boolean } | null {
  const { checkRun, comment } = writeResult;
  if (checkRun.state === "failed" && comment.state === "failed") {
    return {
      message: `check run failed${checkRun.status ? ` (HTTP ${checkRun.status})` : ""}; comment failed${comment.status ? ` (HTTP ${comment.status})` : ""}`,
      retryable: checkRun.retryable || comment.retryable,
    };
  }
  if (checkRun.state === "failed") {
    return {
      message: `check run failed${checkRun.status ? ` (HTTP ${checkRun.status})` : ""} — the comment alone cannot substitute for the machine-readable trust result`,
      retryable: checkRun.retryable,
    };
  }
  if (comment.state === "failed") {
    return {
      message: `comment failed${comment.status ? ` (HTTP ${comment.status})` : ""}`,
      retryable: comment.retryable,
    };
  }
  return null;
}

/**
 * Create the Check Run with independent error handling (never throws): the
 * trust result is the primary machine-readable outcome and must survive a
 * comment/API hiccup. Returns the structured outcome.
 */
async function createCheckRunSafe(
  github: GitHubClientLike,
  owner: string,
  repo: string,
  headSha: string,
  conclusion: { conclusion: "success" | "neutral" | "failure"; title: string; summary: string },
  commentBody: string,
  enabled: boolean,
): Promise<GitHubWriteResult["checkRun"]> {
  if (!enabled) return { state: "skipped", reason: "check-run disabled" };
  try {
    const id = await github.createCheckRun(owner, repo, {
      name: "Drift intent check",
      headSha,
      conclusion: conclusion.conclusion,
      title: conclusion.title,
      summary: `${conclusion.summary}\n\n${commentBody}`,
    });
    return { state: "success", id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { state: "failed", ...failureClass(message) };
  }
}

/**
 * Post the summary, or update the canonical OWNED Drift comment in place.
 * Spoofed user-authored markers are left untouched (ownership is verified by
 * GitHub-attested authorship — a real performed_via_github_app.id matching
 * the configured App id — never by marker presence alone). Never throws;
 * returns the structured outcome.
 */
async function writeOwnedCommentSafe(
  github: GitHubClientLike,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  expectedAppId: string | null | undefined,
): Promise<GitHubWriteResult["comment"]> {
  try {
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
      return { state: "success", id: existing.id, action: "updated" };
    }
    const id = await github.postComment(owner, repo, prNumber, body);
    return { state: "success", id, action: "commented" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { state: "failed", ...failureClass(message) };
  }
}
