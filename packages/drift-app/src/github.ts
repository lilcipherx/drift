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

export interface GitHubClientLike {
  setInstallation(id: number): void;
  getPullCommits(owner: string, repo: string, number: number): Promise<PullCommit[]>;
  getObjectPaths(owner: string, repo: string, ref: string): Promise<string[]>;
  getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null>;
  postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void>;
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
    const res = await this.request(`/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`, token);
    if (!res.ok) throw new Error(`getPullCommits failed: ${res.status}`);
    const data = (await res.json()) as { sha: string; commit: { message: string } }[];
    return data.map((c) => ({ sha: c.sha, message: c.commit.message }));
  }

  /** All file paths under `.drift/objects/` reachable from `ref`. */
  async getObjectPaths(owner: string, repo: string, ref: string): Promise<string[]> {
    const token = await this.getInstallationToken(await this.requireInstallation());
    const res = await this.request(`/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, token);
    if (!res.ok) return []; // no tree (e.g. empty repo) — nothing to index
    const data = (await res.json()) as { tree?: { path?: string; type?: string }[] };
    return (data.tree ?? [])
      .filter((t) => t.type === "blob" && t.path?.startsWith(".drift/objects/") && t.path.endsWith(".json"))
      .map((t) => t.path!)
      .sort();
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

  // ----------------------------------------------------------- writes
  async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    const token = await this.getInstallationToken(await this.requireInstallation());
    const res = await this.request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, token, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`postComment failed: ${res.status} ${await res.text()}`);
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
