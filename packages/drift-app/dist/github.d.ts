/**
 * Minimal GitHub API client for the Drift app (PRD §16.2/§16.4).
 *
 * Authentication: GitHub App JWT → installation access token (short-lived).
 * The interface `GitHubClientLike` is what the webhook handler depends on, so
 * tests can inject a fake with zero network access.
 */
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
    user?: {
        login?: string;
        type?: string;
    } | null;
    performed_via_github_app?: {
        id?: number;
    } | null;
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
export declare class RateLimitError extends Error {
    readonly retryAfterMs: number;
    readonly status: number;
    constructor(message: string, retryAfterMs: number, status: number);
}
export interface RateLimitStatus {
    remaining: number;
    limit: number;
    resetEpochSec: number;
    /** Count of 429/403-secondary responses observed. */
    throttled: number;
}
export declare class GitHubAppClient implements GitHubClientLike {
    private readonly opts;
    private readonly baseUrl;
    private readonly fetchImpl;
    /** Installation-scoped token cache (multi-tenant safe). */
    private installationTokens;
    private readonly requestTimeoutMs;
    private readonly breakerThreshold;
    private readonly breakerResetMs;
    /** Rate-limit snapshot from the most recent response (per client). */
    private rateLimit;
    /** Installation-token circuit breaker state. */
    private breakerFailures;
    private breakerOpenUntil;
    constructor(opts: GitHubAppClientOptions);
    /** Latest observed GitHub rate-limit status for this client. */
    getRateLimitStatus(): RateLimitStatus;
    /** Record rate-limit headers from a response (defensive parsing). */
    private trackRateLimit;
    /**
     * Classify rate-limit responses: 429 always; 403 with Retry-After (the
     * GitHub secondary-rate-limit signal) throws RateLimitError so callers
     * retry with backoff instead of failing the audit permanently.
     */
    private checkRateLimit;
    private appJwt;
    /** Exchange the app JWT for a short-lived installation access token (cached per installation). */
    getInstallationToken(installationId: number): Promise<string>;
    private request;
    getPullRequest(owner: string, repo: string, number: number): Promise<PullRequestInfo>;
    getPullCommits(owner: string, repo: string, number: number): Promise<PullCommitCollection>;
    getCompareCommits(owner: string, repo: string, baseSha: string, headSha: string): Promise<string[]>;
    getPullFiles(owner: string, repo: string, number: number): Promise<PullFilesResult>;
    /** File NAMES in a directory at a ref ([] when the dir does not exist). */
    listDirectory(owner: string, repo: string, path: string, ref: string): Promise<string[]>;
    /** Raw UTF-8 content of a file at a ref, or null when absent. */
    getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null>;
    /**
     * All issue/PR comments, most recent first (idempotency needs the existing
     * Drift comment). Paginates through the Link header (cap 10 pages) so the
     * marker comment is found even on heavily-commented PRs.
     */
    listIssueComments(owner: string, repo: string, issueNumber: number): Promise<IssueComment[]>;
    postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<number>;
    /** PATCH an existing comment in place (keeps the thread tidy across synchronize events). */
    updateComment(owner: string, repo: string, commentId: number, body: string): Promise<void>;
    createCheckRun(owner: string, repo: string, input: CheckRunInput): Promise<number>;
    setInstallation(id: number): void;
    getAppId(): string | null;
    private installationId;
    private requireInstallation;
}
//# sourceMappingURL=github.d.ts.map