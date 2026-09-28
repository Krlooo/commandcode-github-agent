/**
 * Event parsing for the Command Code GitHub Action.
 *
 * Pure functions: turn a raw GitHub webhook payload into a {@link Trigger}.
 */

export type TriggerKind =
  | "issue_comment"
  | "pull_request_review_comment"
  | "issues"
  | "workflow_dispatch";

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
  /** The raw trigger comment body, for scanning attachments (comment triggers only). */
  commentBody?: string;
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

interface CommentTarget {
  number: number;
  title: string;
  body: string;
  isPullRequest: boolean;
}

/**
 * Shared parsing for the comment triggers (`issue_comment` and
 * `pull_request_review_comment`): a created comment carrying a mention, with the
 * task falling back to the target's title + body when the comment has no text.
 */
function parseCommentTrigger(
  kind: "issue_comment" | "pull_request_review_comment",
  root: Record<string, unknown>,
  identity: { owner: string; repo: string },
  mentions: string[],
  target: CommentTarget,
): Trigger | null {
  const comment = asRecord(root["comment"]);
  if (!comment) return null;

  const commentBody = asString(comment["body"]) ?? "";
  const extracted = extractPrompt(commentBody, mentions);
  if (extracted === null) return null;

  const actor =
    asString(asRecord(comment["user"])?.["login"]) ?? asString(asRecord(root["sender"])?.["login"]) ?? "";
  const prompt = extracted.length > 0 ? extracted : `${target.title}\n\n${target.body}`;

  const trigger: Trigger = {
    kind,
    owner: identity.owner,
    repo: identity.repo,
    number: target.number,
    isPullRequest: target.isPullRequest,
    actor,
    prompt,
    title: target.title,
    body: target.body,
    commentBody,
  };

  const commentId = asNumber(comment["id"]);
  if (commentId !== undefined) trigger.commentId = commentId;
  return trigger;
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

    const issue = asRecord(root["issue"]);
    const number = asNumber(issue?.["number"]);
    if (!issue || number === undefined) return null;

    return parseCommentTrigger("issue_comment", root, identity, mentions, {
      number,
      title: asString(issue["title"]) ?? "",
      body: asString(issue["body"]) ?? "",
      isPullRequest: looksLikePullRequest(issue),
    });
  }

  if (eventName === "pull_request_review_comment") {
    if (asString(root["action"]) !== "created") return null;

    const pull = asRecord(root["pull_request"]);
    const number = asNumber(pull?.["number"]);
    if (!pull || number === undefined) return null;

    return parseCommentTrigger("pull_request_review_comment", root, identity, mentions, {
      number,
      title: asString(pull["title"]) ?? "",
      body: asString(pull["body"]) ?? "",
      isPullRequest: true,
    });
  }

  if (eventName === "issues") {
    const action = asString(root["action"]);
    if (action !== "opened" && action !== "labeled" && action !== "assigned") return null;
    if (action === "assigned") {
      const assignee = asString(asRecord(root["assignee"])?.["login"]);
      if (assignee === undefined || !assignee.endsWith("[bot]")) return null;
    }

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
