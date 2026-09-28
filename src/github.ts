/**
 * Minimal GitHub REST client built on the global `fetch` (Node 20).
 * Zero dependencies; every method narrows the JSON defensively.
 */

import { MAX_CONTEXT_COMMENTS } from "./prompt";

export interface GitHubClientOptions {
  token: string;
  owner: string;
  repo: string;
  apiBase?: string;
}

export interface RepoInfo {
  default_branch: string;
}

export interface IssueLabel {
  name?: string;
}

export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  user: { login: string };
  labels: IssueLabel[];
  pull_request?: unknown;
}

export interface IssueComment {
  author: string;
  body: string;
}

export interface PullInfo {
  head: {
    ref: string;
    sha: string;
    repo: { full_name: string; owner: { login: string } } | null;
  };
  base: { ref: string };
  mergeable?: boolean;
}

export type CollaboratorPermission = "admin" | "write" | "read" | "none";

export interface CreatePullRequestInput {
  title: string;
  head: string;
  base: string;
  body: string;
}

export interface CreatedPullRequest {
  number: number;
  html_url: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export class GitHubClient {
  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly apiBase: string;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.owner = options.owner;
    this.repo = options.repo;
    this.apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "commandcode-github-agent",
    };

    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.apiBase}${path}`, init);
    if (!response.ok) {
      throw new Error(
        `GitHub API ${method} ${path} failed: ${response.status} ${await this.errorMessage(response)}`,
      );
    }

    if (response.status === 204) return undefined;
    const text = await response.text();
    if (text.length === 0) return undefined;
    return JSON.parse(text) as unknown;
  }

  private async errorMessage(response: { statusText: string; text: () => Promise<string> }): Promise<string> {
    try {
      const text = await response.text();
      if (!text) return response.statusText;
      const parsed = asRecord(JSON.parse(text) as unknown);
      const message = asString(parsed?.["message"]);
      return message ?? text;
    } catch {
      return response.statusText;
    }
  }

  private issuePath(suffix = ""): string {
    return `/repos/${this.owner}/${this.repo}${suffix}`;
  }

  /**
   * Route prefix for a comment's reactions: review comments live under
   * `/pulls/comments/{id}`, plain comments under `/issues/comments/{id}`.
   */
  private commentPath(commentId: number, kind: "issue" | "review"): string {
    return kind === "review" ? `/pulls/comments/${commentId}` : `/issues/comments/${commentId}`;
  }

  async getRepo(): Promise<RepoInfo> {
    const data = asRecord(await this.request("GET", this.issuePath()));
    return { default_branch: asString(data?.["default_branch"]) ?? "main" };
  }

  async getIssue(number: number): Promise<IssueInfo> {
    const data = asRecord(await this.request("GET", this.issuePath(`/issues/${number}`)));
    if (!data) throw new Error(`GitHub API returned an unexpected issue payload for #${number}`);

    const labels = asArray(data["labels"]).map((label): IssueLabel => {
      if (typeof label === "string") return { name: label };
      const record = asRecord(label);
      return { name: asString(record?.["name"]) };
    });

    const issue: IssueInfo = {
      number: asNumber(data["number"]) ?? number,
      title: asString(data["title"]) ?? "",
      body: asString(data["body"]) ?? "",
      user: { login: asString(asRecord(data["user"])?.["login"]) ?? "" },
      labels,
    };
    if (data["pull_request"] !== undefined) issue.pull_request = data["pull_request"];
    return issue;
  }

  async getIssueComments(number: number, limit = MAX_CONTEXT_COMMENTS): Promise<IssueComment[]> {
    const perPage = Math.min(Math.max(limit, 1), 100);
    const data = await this.request(
      "GET",
      this.issuePath(
        `/issues/${number}/comments?per_page=${perPage}&sort=created&direction=desc`,
      ),
    );

    const mapped: IssueComment[] = [];
    for (const item of asArray(data)) {
      const record = asRecord(item);
      mapped.push({
        author: asString(asRecord(record?.["user"])?.["login"]) ?? "unknown",
        body: asString(record?.["body"]) ?? "",
      });
    }

    // Newest-first from the API; return the last `limit` comments in chronological order.
    return mapped.slice(0, limit).reverse();
  }

  async getCollaboratorPermissionLevel(login: string): Promise<CollaboratorPermission> {
    const data = asRecord(
      await this.request(
        "GET",
        this.issuePath(`/collaborators/${encodeURIComponent(login)}/permission`),
      ),
    );
    const permission = asString(data?.["permission"]);
    if (permission === "admin" || permission === "write" || permission === "read" || permission === "none") {
      return permission;
    }
    return "none";
  }

  async addReaction(
    commentId: number,
    content: string,
    kind: "issue" | "review" = "issue",
  ): Promise<{ id: number }> {
    const data = asRecord(
      await this.request("POST", this.issuePath(`${this.commentPath(commentId, kind)}/reactions`), {
        content,
      }),
    );
    return { id: asNumber(data?.["id"]) ?? 0 };
  }

  async deleteReaction(
    commentId: number,
    reactionId: number,
    kind: "issue" | "review" = "issue",
  ): Promise<void> {
    await this.request(
      "DELETE",
      this.issuePath(`${this.commentPath(commentId, kind)}/reactions/${reactionId}`),
    );
  }

  async postComment(number: number, body: string): Promise<{ id: number; html_url: string }> {
    const data = asRecord(
      await this.request("POST", this.issuePath(`/issues/${number}/comments`), { body }),
    );
    return { id: asNumber(data?.["id"]) ?? 0, html_url: asString(data?.["html_url"]) ?? "" };
  }

  async getPull(number: number): Promise<PullInfo> {
    const data = asRecord(await this.request("GET", this.issuePath(`/pulls/${number}`)));
    const head = asRecord(data?.["head"]);
    const headRepo = asRecord(head?.["repo"]);
    const base = asRecord(data?.["base"]);
    const mergeable = data?.["mergeable"];

    const pull: PullInfo = {
      head: {
        ref: asString(head?.["ref"]) ?? "",
        sha: asString(head?.["sha"]) ?? "",
        repo: headRepo
          ? {
              full_name: asString(headRepo["full_name"]) ?? "",
              owner: { login: asString(asRecord(headRepo["owner"])?.["login"]) ?? "" },
            }
          : null,
      },
      base: { ref: asString(base?.["ref"]) ?? "" },
    };
    if (typeof mergeable === "boolean") pull.mergeable = mergeable;
    return pull;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<CreatedPullRequest> {
    const data = asRecord(await this.request("POST", this.issuePath(`/pulls`), input));
    return {
      number: asNumber(data?.["number"]) ?? 0,
      html_url: asString(data?.["html_url"]) ?? "",
    };
  }
}
