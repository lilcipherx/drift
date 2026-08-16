/**
 * Minimal GitHub API client for the Drift app (PRD §16.2/§16.4).
 *
 * Authentication: GitHub App JWT → installation access token (short-lived).
 * The interface `GitHubClientLike` is what the webhook handler depends on, so
 * tests can inject a fake with zero network access.
 */
import { createAppJwt } from "./jwt.js";
export class GitHubAppClient {
    opts;
    baseUrl;
    fetchImpl;
    /** Installation-scoped token cache (multi-tenant safe). */
    installationTokens = new Map();
    constructor(opts) {
        this.opts = opts;
        this.baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }
    appJwt() {
        return createAppJwt(this.opts.appId, this.opts.privateKeyPem);
    }
    /** Exchange the app JWT for a short-lived installation access token (cached per installation). */
    async getInstallationToken(installationId) {
        const cached = this.installationTokens.get(installationId);
        if (cached && cached.expiresAt > Date.now() + 30_000)
            return cached.value;
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
        const data = (await res.json());
        this.installationTokens.set(installationId, {
            value: data.token,
            expiresAt: Date.parse(data.expires_at),
        });
        return data.token;
    }
    async request(path, token, init = {}) {
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
    async getPullRequest(owner, repo, number) {
        const token = await this.getInstallationToken(await this.requireInstallation());
        const res = await this.request(`/repos/${owner}/${repo}/pulls/${number}`, token);
        if (!res.ok)
            throw new Error(`getPullRequest failed: ${res.status}`);
        const data = (await res.json());
        return { headSha: data.head.sha, title: data.title };
    }
    async getPullCommits(owner, repo, number) {
        const token = await this.getInstallationToken(await this.requireInstallation());
        const commits = [];
        // Paginate so PRs with more than 100 commits still get fully scanned
        // (cap at 5 000 commits to stay bounded on pathological PRs).
        let path = `/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`;
        for (let page = 0; path && page < 50; page++) {
            const res = await this.request(path, token);
            if (!res.ok)
                throw new Error(`getPullCommits failed: ${res.status}`);
            const data = (await res.json());
            commits.push(...data.map((c) => ({ sha: c.sha, message: c.commit.message })));
            path = nextPagePath(res.headers.get("link"));
        }
        return commits;
    }
    async getPullFiles(owner, repo, number) {
        const token = await this.getInstallationToken(await this.requireInstallation());
        const files = [];
        let path = `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`;
        for (let page = 0; path && page < 20; page++) {
            const res = await this.request(path, token);
            if (!res.ok)
                throw new Error(`getPullFiles failed: ${res.status}`);
            const data = (await res.json());
            files.push(...data.map((f) => ({
                filename: f.filename,
                status: f.status,
                ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}),
            })));
            path = nextPagePath(res.headers.get("link"));
        }
        return files;
    }
    /** File NAMES in a directory at a ref ([] when the dir does not exist). */
    async listDirectory(owner, repo, path, ref) {
        const token = await this.getInstallationToken(await this.requireInstallation());
        const res = await this.request(`/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, token);
        if (res.status === 404)
            return [];
        if (!res.ok)
            throw new Error(`listDirectory ${path} failed: ${res.status}`);
        const data = (await res.json());
        if (!Array.isArray(data))
            return [];
        return data.map((d) => d.name).filter((n) => typeof n === "string");
    }
    /** Raw UTF-8 content of a file at a ref, or null when absent. */
    async getFileContent(owner, repo, path, ref) {
        const token = await this.getInstallationToken(await this.requireInstallation());
        const res = await this.request(`/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, token);
        if (res.status === 404)
            return null;
        if (!res.ok)
            throw new Error(`getFileContent ${path} failed: ${res.status}`);
        const data = (await res.json());
        if (!data.content)
            return null;
        return Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf8").toString("utf8");
    }
    /**
     * All issue/PR comments, most recent first (idempotency needs the existing
     * Drift comment). Paginates through the Link header (cap 10 pages) so the
     * marker comment is found even on heavily-commented PRs.
     */
    async listIssueComments(owner, repo, issueNumber) {
        const token = await this.getInstallationToken(await this.requireInstallation());
        const comments = [];
        let path = `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`;
        for (let page = 0; path && page < 10; page++) {
            const res = await this.request(path, token);
            if (!res.ok)
                throw new Error(`listIssueComments failed: ${res.status}`);
            const data = (await res.json());
            comments.push(...data.map((c) => ({
                id: c.id,
                body: c.body,
                user: c.user,
                performed_via_github_app: c.performed_via_github_app,
            })));
            path = nextPagePath(res.headers.get("link"));
        }
        return comments;
    }
    // ----------------------------------------------------------- writes
    async postComment(owner, repo, issueNumber, body) {
        const token = await this.getInstallationToken(await this.requireInstallation());
        const res = await this.request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, token, {
            method: "POST",
            body: JSON.stringify({ body }),
        });
        if (!res.ok)
            throw new Error(`postComment failed: ${res.status} ${await res.text()}`);
    }
    /** PATCH an existing comment in place (keeps the thread tidy across synchronize events). */
    async updateComment(owner, repo, commentId, body) {
        const token = await this.getInstallationToken(await this.requireInstallation());
        const res = await this.request(`/repos/${owner}/${repo}/issues/comments/${commentId}`, token, {
            method: "PATCH",
            body: JSON.stringify({ body }),
        });
        if (!res.ok)
            throw new Error(`updateComment failed: ${res.status} ${await res.text()}`);
    }
    async createCheckRun(owner, repo, input) {
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
        if (!res.ok)
            throw new Error(`createCheckRun failed: ${res.status} ${await res.text()}`);
    }
    setInstallation(id) {
        this.installationId = id;
    }
    getAppId() {
        return this.opts.appId?.trim() || null;
    }
    installationId = null;
    async requireInstallation() {
        if (this.installationId == null) {
            throw new Error("installation id is not set — call setInstallation() from the webhook payload");
        }
        return this.installationId;
    }
}
function encodePath(path) {
    return path.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}
/** Extract the relative path of the `rel="next"` page from a Link header. */
function nextPagePath(link) {
    if (!link)
        return null;
    for (const part of link.split(",").map((p) => p.trim())) {
        const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
        if (m) {
            try {
                const u = new URL(m[1]);
                return u.pathname + u.search;
            }
            catch {
                return m[1];
            }
        }
    }
    return null;
}
//# sourceMappingURL=github.js.map