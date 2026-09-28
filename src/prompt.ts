/**
 * Prompt templates for the implementer and reviewer agents.
 *
 * The literals in these templates are part of the test contract and must not be
 * reworded (e.g. "do not create branches", "do not push",
 * "run the project's checks", "no verification output").
 */

export interface TaskComment {
  author: string;
  body: string;
}

export interface TaskContext {
  owner: string;
  repo: string;
  number: number;
  isPullRequest: boolean;
  title: string;
  body: string;
  comments: TaskComment[];
  branch: string;
  task: string;
}

export const MAX_CONTEXT_COMMENTS = 30;

function recentComments(ctx: TaskContext): TaskComment[] {
  return ctx.comments.slice(-MAX_CONTEXT_COMMENTS);
}

function contextLines(ctx: TaskContext): string[] {
  const lines: string[] = [];
  lines.push(`Title: ${ctx.title || "(none)"}`);
  lines.push("");
  lines.push(`Body:`);
  lines.push(ctx.body || "(none)");

  const comments = recentComments(ctx);
  if (comments.length > 0) {
    lines.push("");
    lines.push(`Recent comments:`);
    for (const comment of comments) {
      lines.push(`@${comment.author}: ${comment.body}`);
    }
  }
  return lines;
}

function subject(ctx: TaskContext): string {
  return ctx.isPullRequest ? "pull request" : "issue";
}

export function buildImplementerPrompt(ctx: TaskContext): string {
  const lines: string[] = [];
  lines.push(
    "You are the implementer agent, running headless inside GitHub Actions through Command Code.",
  );
  lines.push(
    `Environment: a GitHub Actions job for ${ctx.owner}/${ctx.repo}, working on ${subject(ctx)} #${ctx.number}.`,
  );
  lines.push(`Working branch: ${ctx.branch} (already checked out in this git checkout).`);
  lines.push("");
  lines.push("## Task");
  lines.push(ctx.task || "(no task text provided)");
  lines.push("");
  lines.push("## Context");
  lines.push(...contextLines(ctx));
  lines.push("");
  lines.push("## Rules");
  lines.push(`- You are already inside a git checkout of the branch ${ctx.branch}; do not create branches.`);
  lines.push("- Make the changes directly in the working tree; do not push.");
  lines.push("- The harness commits, pushes and opens the PR for you, so do not open pull requests.");
  lines.push("- run the project's checks when available (the test, lint and build commands).");
  lines.push("- Finish with a concise summary of the changes you made.");
  return lines.join("\n");
}

export interface ReviewerEvidence {
  diffStat: string;
  verifyOutput: string | null;
}

export function buildReviewerPrompt(ctx: TaskContext, evidence: ReviewerEvidence): string {
  const lines: string[] = [];
  lines.push("You are the reviewer agent, running headless inside GitHub Actions through Command Code.");
  lines.push(
    "You have fresh eyes: you did not write the change under review, so audit it independently.",
  );
  lines.push(`Repository: ${ctx.owner}/${ctx.repo}; reviewing ${subject(ctx)} #${ctx.number}.`);
  lines.push(`Working branch: ${ctx.branch} (already checked out in this git checkout).`);
  lines.push("");
  lines.push("## Task to review");
  lines.push(ctx.task || "(no task text provided)");
  lines.push("");
  lines.push("## Context");
  lines.push(...contextLines(ctx));
  lines.push("");
  lines.push("## Diff produced by the implementer");
  lines.push(evidence.diffStat.trim().length > 0 ? evidence.diffStat : "(no diff stat available)");
  lines.push("");
  lines.push("## Verification output");
  lines.push(
    evidence.verifyOutput && evidence.verifyOutput.trim().length > 0
      ? evidence.verifyOutput
      : "no verification output",
  );
  lines.push("");
  lines.push("## Rules");
  lines.push("- Audit whether the requirement is fully addressed by the current working tree.");
  lines.push("- Explicitly look for anything not addressed, missing or incomplete.");
  lines.push("- Fix any gaps you find directly in the working tree; this is the only fix pass.");
  lines.push("- Do not push, do not create branches, do not open pull requests.");
  lines.push("- Run the checks again after fixing.");
  lines.push("- End with a concise review summary: what is correct, what you fixed, and any remaining risk.");
  return lines.join("\n");
}
