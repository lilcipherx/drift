/**
 * Minimal GitHub API client for the Drift app (PRD §16.2/§16.4).
 *
 * Authentication: GitHub App JWT → installation access token (short-lived).
 * The interface `GitHubClientLike` is what the webhook handler depends on, so
 * tests can inject a fake with zero network access.
 */

import { createAppJwt } from "./jwt.js";

export interface PullCommit {
  sha: string;
  message: string;
}

/**
 * Pull-request commit enumeration WITH completeness proof. The REST
 * `pulls/{n}/commits` endpoint caps at 250 commits; the App must never issue
 * a trust conclusion from a silently truncated list, so the handler compares
 * the returned count against the PR metadata `commits` count and fails the
 * audit when they disagree or when pagination was interrupted.
 */
export interface PullCommitCollection {
  commits: PullCommit[];
  /** PR metadata `commits` count (the expected total). */
  expectedCount: number;
  /** False when the listing is provably incomplete (endpoint cap, page
   *  interruption, duplicate entries, invalid SHAs, count mismatch). */
  complete: boolean;
  reason?: "over-endpoint-limit" | "count-mismatch" | "pagination-interrupted" | "duplicate-sha" | "invalid-sha";
}

/** PR metadata the handler needs for completeness + trust decisions. */
export interface PullRequestInfo {
  headSha: string;
  baseSha: string;
  commits: number;
  changedFiles: number;
  title: string;
}

export interface CheckRunInput {
  name: string;
  headSha: string;
  conclusion: "success" | "neutral" | "failure";
  title: string;
  summary: string;
}

export interface IssueComment {
  id: number;
  body: string;
  /** Server-controlled authorship fields used for Drift comment ownership. */
  user?: { login?: string; type?: string } | null;
  performed_via_github_app?: { id?: number } | null;
}

export interface PullFile {
  filename: string;
  status: string;
  previous_filename?: string;
}

export interface PullFilesResult {
  files: PullFile[];
  /** True when pagination hit its cap before all files were fetched — the
   *  audit must then report itself INCOMPLETE instead of assuming success. */
  truncated: boolean;
}

export interface GitHubClientLike {
  setInstallation(id: number): void;
  /** The configured GitHub App id (for exact comment-ownership matching). */
  getAppId(): string | null;
  getPullRequest(owner: string, repo: string, number: number): Promise<PullRequestInfo>;
  getPullCommits(owner: string, repo: string, number: number): Promise<PullCommitCollection>;
  /** Commits reachable from head but NOT from base (compare base...head) —
   *  used to distinguish a NEW trailer reference from one carried in from
   *  base history (legacy provenance). */
  getCompareCommits(owner: string, repo: string, baseSha: string, headSha: string): Promise<string[]>;
  /** All changed files of the PR (paginated, so PRs with >100 files work). */
  getPullFiles(owner: string, repo: string, number: number): Promise<PullFilesResult>;
  getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null>;
  /** File NAMES in a directory at a ref ([] when the dir does not exist). */
  listDirectory(owner: string, repo: string, path: string, ref: string): Promise<string[]>;
  listIssueComments(owner: string, repo: string, issueNumber: number): Promise<IssueComment[]>;
  /** Returns the created comment id. */
  postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<number>;
  updateComment(owner: string, repo: string, commentId: number, body: string): Promise<void>;
  /** Returns the created check-run id. */
  createCheckRun(owner: string, repo: string, input: CheckRunInput): Promise<number>;
}

export interface GitHubAppClientOptions {
  appId: string;
  privateKeyPem: string;
  /** Override for tests (e.g. a local mock server). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). Default 30 s. */
  requestTimeoutMs?: number;
  /** Circuit-breaker: consecutive token-request failures that open the
   *  breaker (0 disables). Default 5. */
  breakerThreshold?: number;
  /** Circuit open window (ms). Default 15 s. */
  breakerResetMs?: number;
}

/** Thrown for GitHub rate-limit responses (429 or secondary 403 with
 *  Retry-After). The handler treats these as transient (retryable). */
export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
    readonly status: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export interface RateLimitStatus {
  remaining: number;
  limit: number;
  resetEpochSec: number;
  /** Count of 429/403-secondary responses observed. */
  throttled: number;
}

/** Parse X-RateLimit-* headers defensively (untrusted network input). */
function parseRateLimitHeaders(headers: Headers): { remaining: number; limit: number; reset: number } | null {
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  const limit = Number(headers.get("x-ratelimit-limit"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || !Number.isFinite(reset)) return null;
  return { remaining, limit, reset };
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

export class GitHubAppClient implements GitHubClientLike {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  /** Installation-scoped token cache (multi-tenant safe). */
  private installationTokens = new Map<number, { value: string; expiresAt: number }>();
  private readonly requestTimeoutMs: number;
  private readonly breakerThreshold: number;
  private readonly breakerResetMs: number;
  /** Rate-limit snapshot from the most recent response (per client). */
  private rateLimit: RateLimitStatus = { remaining: -1, limit: -1, resetEpochSec: 0, throttled: 0 };
  /** Installation-token circuit breaker state. */
  private breakerFailures = 0;
  private breakerOpenUntil = 0;

  constructor(private readonly opts: GitHubAppClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestTimeoutMs =
      Number.isFinite(opts.requestTimeoutMs) && (opts.requestTimeoutMs ?? 0) > 0
        ? (opts.requestTimeoutMs as number)
        : 30_000;
    this.breakerThreshold = Number.isFinite(opts.breakerThreshold) && (opts.breakerThreshold ?? 0) > 0 ? (opts.breakerThreshold as number) : 5;
    this.breakerResetMs = Number.isFinite(opts.breakerResetMs) && (opts.breakerResetMs ?? 0) > 0 ? (opts.breakerResetMs as number) : 15_000;
  }

  /** Latest observed GitHub rate-limit status for this client. */
  getRateLimitStatus(): RateLimitStatus {
    return { ...this.rateLimit };
  }

  /** Record rate-limit headers from a response (defensive parsing). */
  private trackRateLimit(headers: Headers): void {
    const parsed = parseRateLimitHeaders(headers);
    if (parsed) {
      this.rateLimit = {
        remaining: parsed.remaining,
        limit: parsed.limit,
        resetEpochSec: parsed.reset,
        throttled: this.rateLimit.throttled,
      };
    }
  }

  /**
   * Classify rate-limit responses: 429 always; 403 with Retry-After (the
   * GitHub secondary-rate-limit signal) throws RateLimitError so callers
   * retry with backoff instead of failing the audit permanently.
   */
  private checkRateLimit(res: Response, opLabel: string): void {
    if (res.status === 429) {
      this.rateLimit.throttled++;
      const wait = retryAfterMs(res.headers) ?? 60_000;
      throw new RateLimitError(`${opLabel} failed: 429 rate limited (retry in ${Math.ceil(wait / 1000)}s)`, wait, 429);
    }
    if (res.status === 403 && res.headers.get("retry-after")) {
      this.rateLimit.throttled++;
      const wait = retryAfterMs(res.headers) ?? 60_000;
      throw new RateLimitError(`${opLabel} failed: 403 secondary rate limited (retry in ${Math.ceil(wait / 1000)}s)`, wait, 403);
    }
  }

  private appJwt(): string {
    return createAppJwt(this.opts.appId, this.opts.privateKeyPem);
  }

  /** Exchange the app JWT for a short-lived installation access token (cached per installation). */
  async getInstallationToken(installationId: number): Promise<string> {
    const cached = this.installationTokens.get(installationId);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.value;
    // Circuit breaker: repeated token-request failures (e.g. GitHub outage or
    // a revoked App key) open the circuit briefly so workers stop hammering
    // the API and fail fast with a retryable error.
    if (this.breakerOpenUntil > Date.now()) {
      throw new Error(`installation token request failed: 503 breaker open (retry in ${Math.ceil((this.breakerOpenUntil - Date.now()) / 1000)}s)`);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.appJwt()}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          // GitHub rejects requests without a User-Agent (403).
          "User-Agent": "drift-app/0.1.0",
        },
        body: "{}",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      // Network/timeout failures are transient — do not open the breaker on
      // them (a single outage would trip every installation).
      throw new Error(`installation token request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      this.checkRateLimit(res, "installation token request");
      this.breakerFailures++;
      if (this.breakerFailures >= this.breakerThreshold) {
        this.breakerOpenUntil = Date.now() + this.breakerResetMs;
        this.breakerFailures = 0;
      }
      throw new Error(`installation token request failed: ${res.status} ${await res.text()}`);
    }
    this.breakerFailures = 0;
    const data = (await res.json()) as { token: string; expires_at: string };
    this.installationTokens.set(installationId, {
      value: data.token,
      expiresAt: Date.parse(data.expires_at),
    });
    return data.token;
  }

  private async request(path: string, token: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "drift-app/0.1.0",
        ...(init.headers ?? {}),
      },
      // Bounded per-request timeout: a stalled GitHub connection must never
      // hold a worker slot or webhook connection indefinitely.
      ...(init.signal ? {} : { signal: AbortSignal.timeout(this.requestTimeoutMs) }),
    });
    this.trackRateLimit(res.headers);
    this.checkRateLimit(res, path.split("?")[0] ?? path);
    return res;
  }

  // ------------------------------------------------------------ reads
  async getPullRequest(owner: string, repo: string, number: number): Promise<PullRequestInfo> {
    const token = await this.getInstallationToken(await this.requireInstallation());
    const res = await this.request(`/repos/${owner}/${repo}/pulls/${number}`, token);
    if (!res.ok) throw new Error(`getPullRequest failed: ${res.status}`);
    const data = (await res.json()) as {
      head: { sha: string };
      base: { sha: string };
      commits?: number;
      changed_files?: number;
      title?: string;
    };
    return {
      headSha: data.head.sha,
      baseSha: data.base.sha,
      commits: typeof data.commits === "number" ? data.commits : -1,
      changedFiles: typeof data.changed_files === "number" ? data.changed_files : -1,
      title: data.title ?? "",
    };
  }

  async getPullCommits(owner: string, repo: string, number: number): Promise<PullCommitCollection> {
    const info = await this.getPullRequest(owner, repo, number);
    const token = await this.getInstallationToken(await this.requireInstallation());
    const commits: PullCommit[] = [];
    let interrupted = false;
    // The REST endpoint itself caps at 250 commits; paginate through Link
    // headers (bounded at 50 pages) and let completeness detection decide.
    let path: string | null = `/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`;
    for (let page = 0; path && page < 50; page++) {
      const res = await this.request(path, token);
      if (!res.ok) throw new Error(`getPullCommits failed: ${res.status}`);
      const data = (await res.json()) as { sha: string; commit: { message: string } }[];
      if (!Array.isArray(data) || data.length === 0) {
        // A legitimately EMPTY pull request has zero commits: an empty first
        // page with an expected count of 0 is a complete listing. Any other
        // empty page means the API stopped producing data — interrupted. In
        // BOTH cases clear `path` so the post-loop cap check cannot turn the
        // legitimate empty listing into a spurious interruption.
        path = null;
        if (commits.length === 0 && info.commits === 0) break;
        interrupted = true;
        break;
      }
      commits.push(...data.map((c) => ({ sha: c.sha, message: c.commit.message })));
      path = nextPagePath(res.headers.get("link"));
    }
    if (path && path.length > 0) interrupted = true;

    // Completeness proof: the returned list must match the PR metadata count
    // exactly, contain no duplicate or blank SHAs, and never hit the page cap.
    const dup = commits.length !== new Set(commits.map((c) => c.sha)).size;
    const invalidSha = commits.some((c) => typeof c.sha !== "string" || !/^[0-9a-f]{40}$/.test(c.sha));
    // The Pull Request Commits REST endpoint has a HARD maximum of 250
    // commits: an expected count above that can never be fully enumerated.
    const overLimit = info.commits > 250;
    const countMismatch = !overLimit && commits.length !== info.commits;
    const complete = !interrupted && !dup && !invalidSha && !overLimit && !countMismatch;
    let reason: PullCommitCollection["reason"];
    if (complete) {
      reason = undefined;
    } else if (overLimit) {
      reason = "over-endpoint-limit";
    } else if (interrupted) {
      reason = "pagination-interrupted";
    } else if (dup) {
      reason = "duplicate-sha";
    } else if (invalidSha) {
      reason = "invalid-sha";
    } else {
      reason = "count-mismatch";
    }
    return {
      commits,
      expectedCount: info.commits,
      complete,
      ...(reason ? { reason } : {}),
    };
  }

  async getCompareCommits(owner: string, repo: string, baseSha: string, headSha: string): Promise<string[]> {
    const token = await this.getInstallationToken(await this.requireInstallation());
    const shas: string[] = [];
    let path: string | null = `/repos/${owner}/${repo}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}?per_page=100`;
    for (let page = 0; path && page < 20; page++) {
      const res = await this.request(path, token);
      if (!res.ok) throw new Error(`getCompareCommits failed: ${res.status}`);
      const data = (await res.json()) as { commits?: { sha?: string }[]; total_commits?: number };
      if (!Array.isArray(data.commits)) break;
      shas.push(...data.commits.map((c) => c.sha).filter((s): s is string => typeof s === "string" && s.length > 0));
      path = nextPagePath(res.headers.get("link"));
    }
    return [...new Set(shas)];
  }

  async getPullFiles(owner: string, repo: string, number: number): Promise<PullFilesResult> {
    const token = await this.getInstallationToken(await this.requireInstallation());
    const files: PullFile[] = [];
    let path: string | null = `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`;
    let truncated = false;
    for (let page = 0; path && page < 20; page++) {
      const res = await this.request(path, token);
      if (!res.ok) throw new Error(`getPullFiles failed: ${res.status}`);
      const data = (await res.json()) as {
        filename: string;
        status: string;
        previous_filename?: string;
      }[];
      files.push(
        ...data.map((f) => ({
          filename: f.filename,
          status: f.status,
          ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}),
        })),
      );
      path = nextPagePath(res.headers.get("link"));
    }
    // Reaching the page cap with a next link still present means the response
    // is INCOMPLETE — the caller must treat the audit as incomplete (a
    // security policy that never infers "no public changes" from a partial
    // listing).
    if (path && path.length > 0) truncated = true;
    return { files, truncated };
  }

  /** File NAMES in a directory at a ref ([] when the dir does not exist). */
  async listDirectory(owner: string, repo: string, path: string, ref: string): Promise<string[]> {
    const token = await this.getInstallationToken(await this.requireInstallation());
    const res = await this.request(
      `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      token,
    );
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`listDirectory ${path} failed: ${res.status}`);
    const data = (await res.json()) as { name?: string }[];
    if (!Array.isArray(data)) return [];
    return data.map((d) => d.name).filter((n): n is string => typeof n === "string");
  }

  /** Raw UTF-8 content of a file at a ref, or null when absent. */
  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    const token = await this.getInstallationToken(await this.requireInstallation());
    const res = await this.request(
      `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      token,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getFileContent ${path} failed: ${res.status}`);
    const data = (await res.json()) as { content?: string; encoding?: string };
    if (!data.content) return null;
    return Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf8").toString("utf8");
  }

  /**
   * All issue/PR comments, most recent first (idempotency needs the existing
   * Drift comment). Paginates through the Link header (cap 10 pages) so the
   * marker comment is found even on heavily-commented PRs.
   */
  async listIssueComments(owner: string, repo: string, issueNumber: number): Promise<IssueComment[]> {
    const token = await this.getInstallationToken(await this.requireInstallation());
    const comments: IssueComment[] = [];
    let path: string | null = `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`;
    for (let page = 0; path && page < 10; page++) {
      const res = await this.request(path, token);
      if (!res.ok) throw new Error(`listIssueComments failed: ${res.status}`);
      const data = (await res.json()) as {
        id: number;
        body: string;
        user?: { login?: string; type?: string } | null;
        performed_via_github_app?: { id?: number } | null;
      }[];
      comments.push(
        ...data.map((c) => ({
          id: c.id,
          body: c.body,
          user: c.user,
          performed_via_github_app: c.performed_via_github_app,
        })),
      );
      path = nextPagePath(res.headers.get("link"));
    }
    return comments;
  }

  // ----------------------------------------------------------- writes
  async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<number> {
    const token = await this.getInstallationToken(await this.requireInstallation());
    const res = await this.request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, token, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`postComment failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { id?: number };
    return typeof data.id === "number" ? data.id : 0;
  }

  /** PATCH an existing comment in place (keeps the thread tidy across synchronize events). */
  async updateComment(owner: string, repo: string, commentId: number, body: string): Promise<void> {
    const token = await this.getInstallationToken(await this.requireInstallation());
    const res = await this.request(`/repos/${owner}/${repo}/issues/comments/${commentId}`, token, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`updateComment failed: ${res.status} ${await res.text()}`);
  }

  async createCheckRun(owner: string, repo: string, input: CheckRunInput): Promise<number> {
    const token = await this.getInstallationToken(await this.requireInstallation());
    const res = await this.request(`/repos/${owner}/${repo}/check-runs`, token, {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        head_sha: input.headSha,
        status: "completed",
        conclusion: input.conclusion,
        output: { title: input.title, summary: input.summary },
      }),
    });
    if (!res.ok) throw new Error(`createCheckRun failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { id?: number };
    return typeof data.id === "number" ? data.id : 0;
  }

  setInstallation(id: number): void {
    this.installationId = id;
  }

  getAppId(): string | null {
    return this.opts.appId?.trim() || null;
  }

  private installationId: number | null = null;

  private async requireInstallation(): Promise<number> {
    if (this.installationId == null) {
      throw new Error("installation id is not set — call setInstallation() from the webhook payload");
    }
    return this.installationId;
  }
}

function encodePath(path: string): string {
  return path.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

/** Extract the relative path of the `rel="next"` page from a Link header. */
function nextPagePath(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",").map((p) => p.trim())) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) {
      try {
        const u = new URL(m[1]!);
        return u.pathname + u.search;
      } catch {
        return m[1]!;
      }
    }
  }
  return null;
}
