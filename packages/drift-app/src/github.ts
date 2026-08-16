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
  getPullCommits(owner: string, repo: string, number: number): Promise<PullCommit[]>;
  /** All changed files of the PR (paginated, so PRs with >100 files work). */
  getPullFiles(owner: string, repo: string, number: number): Promise<PullFilesResult>;
  getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null>;
  /** File NAMES in a directory at a ref ([] when the dir does not exist). */
  listDirectory(owner: string, repo: string, path: string, ref: string): Promise<string[]>;
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

export class GitHubAppClient implements GitHubClientLike {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  /** Installation-scoped token cache (multi-tenant safe). */
  private installationTokens = new Map<number, { value: string; expiresAt: number }>();

  constructor(private readonly opts: GitHubAppClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private appJwt(): string {
    return createAppJwt(this.opts.appId, this.opts.privateKeyPem);
  }

  /** Exchange the app JWT for a short-lived installation access token (cached per installation). */
  async getInstallationToken(installationId: number): Promise<string> {
    const cached = this.installationTokens.get(installationId);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.value;
    const res = await this.fetchImpl(`${this.baseUrl}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.appJwt()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        // GitHub rejects requests without a User-Agent (403).
        "User-Agent": "drift-app/0.1.0",
      },
      body: "{}",
    });
    if (!res.ok) {
      throw new Error(`installation token request failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { token: string; expires_at: string };
    this.installationTokens.set(installationId, {
      value: data.token,
      expiresAt: Date.parse(data.expires_at),
    });
    return data.token;
  }

  private async request(path: string, token: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "drift-app/0.1.0",
        ...(init.headers ?? {}),
      },
    });
  }

  // ------------------------------------------------------------ reads
  async getPullRequest(owner: string, repo: string, number: number) {
    const token = await this.getInstallationToken(await this.requireInstallation());
    const res = await this.request(`/repos/${owner}/${repo}/pulls/${number}`, token);
    if (!res.ok) throw new Error(`getPullRequest failed: ${res.status}`);
    const data = (await res.json()) as { head: { sha: string }; title: string };
    return { headSha: data.head.sha, title: data.title };
  }

  async getPullCommits(owner: string, repo: string, number: number): Promise<PullCommit[]> {
    const token = await this.getInstallationToken(await this.requireInstallation());
    const commits: PullCommit[] = [];
    // Paginate so PRs with more than 100 commits still get fully scanned
    // (cap at 5 000 commits to stay bounded on pathological PRs).
    let path: string | null = `/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`;
    for (let page = 0; path && page < 50; page++) {
      const res = await this.request(path, token);
      if (!res.ok) throw new Error(`getPullCommits failed: ${res.status}`);
      const data = (await res.json()) as { sha: string; commit: { message: string } }[];
      commits.push(...data.map((c) => ({ sha: c.sha, message: c.commit.message })));
      path = nextPagePath(res.headers.get("link"));
    }
    return commits;
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
  async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    const token = await this.getInstallationToken(await this.requireInstallation());
    const res = await this.request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, token, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`postComment failed: ${res.status} ${await res.text()}`);
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

  async createCheckRun(owner: string, repo: string, input: CheckRunInput): Promise<void> {
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
