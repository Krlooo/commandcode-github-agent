/**
 * Event parsing for the Command Code GitHub Action.
 *
 * Pure functions: turn a raw GitHub webhook payload into a {@link Trigger}.
 */

export type TriggerKind = "issue_comment" | "issues" | "workflow_dispatch";

export interface Trigger {
  kind: TriggerKind;
  owner: string;
  repo: string;
  number?: number;
  isPullRequest: boolean;
  actor: string;
  prompt: string;
  commentId?: number;
  title: string;
  body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isWhitespace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

/**
 * Extracts the task text that follows the first mention in a comment body.
 *
 * A mention only triggers when it forms a whole word: it must start the string
 * or be preceded by whitespace, and it must end the string or be followed by
 * whitespace (so `my/cmd` is never a trigger). Returns the trimmed remainder
 * (possibly `""`), or `null` when no mention is present.
 */
export function extractPrompt(commentBody: string, mentions: string[]): string | null {
  let bestIndex = -1;
  let bestLength = 0;

  for (const raw of mentions) {
    const mention = raw.trim();
    if (mention.length === 0) continue;

    let searchFrom = 0;
    while (searchFrom <= commentBody.length) {
      const index = commentBody.indexOf(mention, searchFrom);
      if (index === -1) break;

      const beforeOk = index === 0 || isWhitespace(commentBody[index - 1]);
      const afterIndex = index + mention.length;
      const afterOk = afterIndex >= commentBody.length || isWhitespace(commentBody[afterIndex]);

      if (beforeOk && afterOk) {
        if (bestIndex === -1 || index < bestIndex) {
          bestIndex = index;
          bestLength = mention.length;
        }
        break;
      }
      searchFrom = index + 1;
    }
  }

  if (bestIndex === -1) return null;
  return commentBody.slice(bestIndex + bestLength).trim();
}

function repositoryIdentity(payload: Record<string, unknown>): { owner: string; repo: string } | null {
  const repository = asRecord(payload["repository"]);
  const owner = asString(asRecord(repository?.["owner"])?.["login"]);
  const repo = asString(repository?.["name"]);
  if (!owner || !repo) return null;
  return { owner, repo };
}

function senderLogin(payload: Record<string, unknown>): string {
  return asString(asRecord(payload["sender"])?.["login"]) ?? "";
}

function looksLikePullRequest(issue: Record<string, unknown> | undefined): boolean {
  return asRecord(issue?.["pull_request"]) !== undefined;
}

/**
 * Parses a webhook `eventName` + `payload` into a {@link Trigger}.
 * Returns `null` for any unsupported event/action.
 */
export function parseTrigger(eventName: string, payload: unknown, mentions: string[]): Trigger | null {
  const root = asRecord(payload);
  if (!root) return null;

  const identity = repositoryIdentity(root);
  if (!identity) return null;
  const { owner, repo } = identity;

  if (eventName === "issue_comment") {
    if (asString(root["action"]) !== "created") return null;

    const comment = asRecord(root["comment"]);
    if (!comment) return null;

    const extracted = extractPrompt(asString(comment["body"]) ?? "", mentions);
    if (extracted === null) return null;

    const issue = asRecord(root["issue"]);
    const number = asNumber(issue?.["number"]);
    if (!issue || number === undefined) return null;

    const title = asString(issue["title"]) ?? "";
    const body = asString(issue["body"]) ?? "";
    const actor =
      asString(asRecord(comment["user"])?.["login"]) ?? asString(asRecord(root["sender"])?.["login"]) ?? "";
    const prompt = extracted.length > 0 ? extracted : `${title}\n\n${body}`;

    const trigger: Trigger = {
      kind: "issue_comment",
      owner,
      repo,
      number,
      isPullRequest: looksLikePullRequest(issue),
      actor,
      prompt,
      title,
      body,
    };

    const commentId = asNumber(comment["id"]);
    if (commentId !== undefined) trigger.commentId = commentId;
    return trigger;
  }

  if (eventName === "issues") {
    const action = asString(root["action"]);
    if (action !== "opened" && action !== "labeled") return null;

    const issue = asRecord(root["issue"]);
    const number = asNumber(issue?.["number"]);
    if (!issue || number === undefined) return null;

    const title = asString(issue["title"]) ?? "";
    const body = asString(issue["body"]) ?? "";

    return {
      kind: "issues",
      owner,
      repo,
      number,
      isPullRequest: looksLikePullRequest(issue),
      actor: senderLogin(root),
      prompt: `${title}\n\n${body}`,
      title,
      body,
    };
  }

  if (eventName === "workflow_dispatch") {
    const inputs = asRecord(root["inputs"]);
    const prompt = asString(inputs?.["prompt"])?.trim();
    if (!prompt) return null;

    return {
      kind: "workflow_dispatch",
      owner,
      repo,
      isPullRequest: false,
      actor: senderLogin(root),
      prompt,
      title: "",
      body: "",
    };
  }

  return null;
}
