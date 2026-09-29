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

/** Guards for the `issues` triggers that are not carried by the event action alone. */
export interface TriggerConfig {
  /**
   * Label name that gates `issues: labeled`. When unset or empty, labeled
   * events never trigger a run, so a stray label cannot start the agent.
   */
  label?: string;
  /**
   * Login of the bot this action runs as (for example `commandcode-agent[bot]`).
   * An `issues: assigned` event only triggers when the assignee matches it, so a
   * run is never started by assigning Dependabot, Renovate or any other bot.
   * When unset or empty, assignment events never trigger a run.
   */
  botLogin?: string;
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

/** Logins and label names are matched case-insensitively. */
function equalsIgnoringCase(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
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

export function repositoryIdentity(payload: unknown): { owner: string; repo: string } | null {
  const root = asRecord(payload);
  if (!root) return null;
  const repository = asRecord(root["repository"]);
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
export function parseTrigger(
  eventName: string,
  payload: unknown,
  mentions: string[],
  config: TriggerConfig = {},
): Trigger | null {
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

    // Only an assignment to this app or an explicitly configured label may
    // start a run. `opened` is deliberately absent: it fired on every issue,
    // including from read-only users who then failed the permission gate.
    if (action === "labeled") {
      const label = config.label?.trim();
      if (!label) return null;
      const labelName = asString(asRecord(root["label"])?.["name"]);
      if (labelName === undefined || !equalsIgnoringCase(labelName, label)) return null;
    } else if (action === "assigned") {
      const botLogin = config.botLogin?.trim();
      if (!botLogin) return null;
      const assignee = asString(asRecord(root["assignee"])?.["login"]);
      if (assignee === undefined || !equalsIgnoringCase(assignee, botLogin)) return null;
    } else {
      return null;
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
