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
}
export interface GitHubClientLike {
    setInstallation(id: number): void;
    getPullCommits(owner: string, repo: string, number: number): Promise<PullCommit[]>;
    getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null>;
    listIssueComments(owner: string, repo: string, issueNumber: number): Promise<IssueComment[]>;
    postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void>;
    updateComment(owner: string, repo: string, commentId: number, body: string): Promise<void>;
    createCheckRun(owner: string, repo: string, input: CheckRunInput): Promise<void>;
}
export interface GitHubAppClientOptions {
    appId: string;
    privateKeyPem: string;
    /** Override for tests (e.g. a local mock server). */
    baseUrl?: string;
    fetchImpl?: typeof fetch;
}
export declare class GitHubAppClient implements GitHubClientLike {
    private readonly opts;
    private readonly baseUrl;
    private readonly fetchImpl;
    /** Installation-scoped token cache (multi-tenant safe). */
    private installationTokens;
    constructor(opts: GitHubAppClientOptions);
    private appJwt;
    /** Exchange the app JWT for a short-lived installation access token (cached per installation). */
    getInstallationToken(installationId: number): Promise<string>;
    private request;
    getPullRequest(owner: string, repo: string, number: number): Promise<{
        headSha: string;
        title: string;
    }>;
    getPullCommits(owner: string, repo: string, number: number): Promise<PullCommit[]>;
    /** Raw UTF-8 content of a file at a ref, or null when absent. */
    getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null>;
    /**
     * All issue/PR comments, most recent first (idempotency needs the existing
     * Drift comment). Paginates through the Link header (cap 10 pages) so the
     * marker comment is found even on heavily-commented PRs.
     */
    listIssueComments(owner: string, repo: string, issueNumber: number): Promise<IssueComment[]>;
    postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void>;
    /** PATCH an existing comment in place (keeps the thread tidy across synchronize events). */
    updateComment(owner: string, repo: string, commentId: number, body: string): Promise<void>;
    createCheckRun(owner: string, repo: string, input: CheckRunInput): Promise<void>;
    setInstallation(id: number): void;
    private installationId;
    private requireInstallation;
}
//# sourceMappingURL=github.d.ts.map