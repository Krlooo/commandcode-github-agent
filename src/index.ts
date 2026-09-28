/**
 * Orchestrator (main entry).
 *
 * Trigger -> permission gate -> implementer agent -> verify -> reviewer agent
 * -> commit/push -> pull request (or PR-branch update) -> reply comment.
 *
 * Best-effort: it always reports, never leaves an unhandled rejection, and
 * returns 0 on success / 1 on failure.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { runAgent, type AgentResult } from "./agent";
import { setupAgentAuth } from "./auth";
import { parseTrigger, type Trigger } from "./event";
import * as git from "./git";
import { GitHubClient } from "./github";
import { buildImplementerPrompt, buildReviewerPrompt, type TaskContext } from "./prompt";

const execFileAsync = promisify(execFile);

const MAX_COMMENT_LENGTH = 60000;
const MAX_VERIFY_OUTPUT = 20000;
const MAX_PR_VERIFY_OUTPUT = 4000;
const MAX_SHELL_BUFFER = 64 * 1024 * 1024;

function env(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? fallback : value;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n...(truncated ${text.length - max} characters)`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function parseMentions(value: string): string[] {
  const mentions = value
    .split(",")
    .map((mention) => mention.trim())
    .filter((mention) => mention.length > 0);
  return mentions.length > 0 ? mentions : ["/cmd", "/commandcode"];
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? "commandcode agent changes";
}

function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: process.env["ComSpec"] ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { file: "/bin/sh", args: ["-c", command] };
}

async function runCommand(cwd: string, command: string): Promise<{ output: string; exitCode: number }> {
  const { file, args } = shellInvocation(command);
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { cwd, maxBuffer: MAX_SHELL_BUFFER });
    return { output: [stdout, stderr].filter((part) => part.length > 0).join("\n"), exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown; message?: unknown };
    const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
    const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
    const message = typeof failure.message === "string" ? failure.message : "";
    const output = [stdout, stderr, message].filter((part) => part.length > 0).join("\n");
    const exitCode = typeof failure.code === "number" ? failure.code : 1;
    return { output, exitCode };
  }
}

function summarize(text: string, fallback: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

interface PullRequestBodyOptions {
  number: number | undefined;
  task: string;
  implementer: AgentResult;
  verifyCommand: string;
  verifyOutput: string | null;
  verifyFailed: boolean;
  reviewer: AgentResult | null;
}

function buildPullRequestBody(options: PullRequestBodyOptions): string {
  const sections: string[] = [];

  sections.push("## Task");
  sections.push(options.task.trim() || "(no task text provided)");

  sections.push("## What changed");
  sections.push(summarize(options.implementer.finalText, "(the implementer returned no summary)"));

  sections.push("## Verification");
  if (options.verifyCommand) {
    sections.push(`Command: \`${options.verifyCommand}\``);
    sections.push(`Result: ${options.verifyFailed ? "failed" : "passed"}`);
    sections.push("```");
    sections.push(
      truncate(summarize(options.verifyOutput ?? "", "(no output captured)"), MAX_PR_VERIFY_OUTPUT),
    );
    sections.push("```");
  } else {
    sections.push("not configured");
  }

  sections.push("## Review");
  if (options.reviewer) {
    sections.push(
      options.reviewer.subtype === "error"
        ? `The reviewer agent failed: ${options.reviewer.error ?? "unknown error"}`
        : summarize(options.reviewer.finalText, "(the reviewer returned no summary)"),
    );
  } else {
    sections.push("disabled");
  }

  if (options.number !== undefined) sections.push(`Closes #${options.number}`);

  return truncate(sections.join("\n\n"), MAX_COMMENT_LENGTH);
}

interface ReportOptions {
  branch: string;
  isPullRequest: boolean;
  prUrl: string | null;
  model: string;
  implementer: AgentResult;
  reviewer: AgentResult | null;
  startedAt: number;
  runUrl: string;
}

function buildReport(options: ReportOptions): string {
  const lines: string[] = [];
  lines.push(`Command Code finished the task on branch \`${options.branch}\`.`);

  if (options.prUrl) lines.push(`Pull request: ${options.prUrl}`);
  else if (options.isPullRequest) lines.push("Changes were pushed to the pull request branch.");

  lines.push(`Model: ${options.model || "(default)"}`);

  const sessions: string[] = [];
  if (options.implementer.sessionId) sessions.push(`implementer ${options.implementer.sessionId}`);
  if (options.reviewer?.sessionId) sessions.push(`reviewer ${options.reviewer.sessionId}`);
  if (sessions.length > 0) lines.push(`Sessions: ${sessions.join(", ")}`);

  lines.push(`Duration: ${formatDuration(Date.now() - options.startedAt)}`);
  lines.push(`Run: ${options.runUrl}`);

  return truncate(lines.join("\n"), MAX_COMMENT_LENGTH);
}

async function safeDefaultBranch(github: GitHubClient): Promise<string> {
  try {
    return (await github.getRepo()).default_branch || "main";
  } catch (error) {
    console.warn("Could not read the repository default branch; falling back to main:", error);
    return "main";
  }
}

export async function main(): Promise<number> {
  const startedAt = Date.now();

  const eventName = env("GITHUB_EVENT_NAME");
  const eventPath = env("GITHUB_EVENT_PATH");
  const token = env("GITHUB_TOKEN");
  const workspace = env("GITHUB_WORKSPACE", process.cwd());

  let payload: unknown = {};
  if (eventPath) {
    try {
      payload = JSON.parse(readFileSync(eventPath, "utf8"));
    } catch (error) {
      console.error("Could not read the GitHub event payload:", error);
      return 0;
    }
  }

  const mentions = parseMentions(env("INPUT_MENTIONS", "/cmd,/commandcode"));
  const trigger: Trigger | null = parseTrigger(eventName, payload, mentions);
  if (!trigger) {
    console.log(`No trigger for event "${eventName}"; nothing to do.`);
    return 0;
  }

  const github = new GitHubClient({ token, owner: trigger.owner, repo: trigger.repo });

  // Bot loop guard: a bot-authored trigger must never start another run.
  if (trigger.actor.endsWith("[bot]")) {
    console.log(`Ignoring events from bot actor "${trigger.actor}" to avoid loops.`);
    return 0;
  }
  const model = env("INPUT_MODEL");
  const maxTurns = Number.parseInt(env("INPUT_MAX_TURNS", "100"), 10) || 100;
  const verifyCommand = env("INPUT_VERIFY_COMMAND");
  const reviewEnabled = env("INPUT_REVIEW", "true").toLowerCase() === "true";

  const runUrl = `${env("GITHUB_SERVER_URL", "https://github.com")}/${trigger.owner}/${trigger.repo}/actions/runs/${env("GITHUB_RUN_ID")}`;

  let reactionId: number | undefined;

  const comment = async (message: string): Promise<void> => {
    if (trigger.number === undefined) {
      console.log(message);
      return;
    }
    try {
      await github.postComment(trigger.number, truncate(message, MAX_COMMENT_LENGTH));
    } catch (error) {
      console.error("Failed to post a comment:", error);
    }
  };

  const react = async (content: string): Promise<void> => {
    if (trigger.commentId === undefined) return;
    if (reactionId !== undefined) {
      try {
        await github.deleteReaction(trigger.commentId, reactionId);
      } catch (error) {
        console.warn("Failed to remove the initial reaction:", error);
      }
      reactionId = undefined;
    }
    try {
      const reaction = await github.addReaction(trigger.commentId, content);
      reactionId = reaction.id;
    } catch (error) {
      console.warn("Failed to add a reaction:", error);
    }
  };

  try {
    // 2) Permission gate: only collaborators with write/admin may trigger.
    let permission: "admin" | "write" | "read" | "none";
    try {
      permission = await github.getCollaboratorPermissionLevel(trigger.actor);
    } catch (error) {
      console.error("Could not verify the commenter's permission:", error);
      await comment(
        `Could not verify @${trigger.actor}'s permission on this repository; aborting the run.`,
      );
      return 1;
    }
    if (permission !== "admin" && permission !== "write") {
      await comment(
        `Only collaborators with write access can trigger this command; @${trigger.actor} has "${permission}" access.`,
      );
      return 0;
    }

    // 3) Acknowledge the trigger with a reaction (best effort).
    if (trigger.commentId !== undefined) {
      try {
        const reaction = await github.addReaction(trigger.commentId, "eyes");
        reactionId = reaction.id;
      } catch (error) {
        console.warn("Failed to add the initial reaction:", error);
      }
    }

    // 4) Gather context (recent comments).
    let comments: { author: string; body: string }[] = [];
    if (trigger.number !== undefined) {
      try {
        comments = await github.getIssueComments(trigger.number);
      } catch (error) {
        console.warn("Failed to load issue comments:", error);
      }
    }

    // 5) Determine the working branch.
    let branch: string;
    let baseBranch = "";
    if (trigger.isPullRequest) {
      if (trigger.number === undefined) {
        console.error("A pull request trigger without a number cannot be handled.");
        return 0;
      }
      const pull = await github.getPull(trigger.number);
      const expectedRepo = `${trigger.owner}/${trigger.repo}`;
      if (!pull.head.repo || pull.head.repo.full_name !== expectedRepo) {
        await comment(
          "Pull requests opened from a fork are not supported yet; please trigger the agent on an issue or a same-repository pull request.",
        );
        await react("-1");
        return 0;
      }
      branch = pull.head.ref;
      try {
        await git.fetchBranch(workspace, branch);
        await git.checkoutBranch(workspace, branch);
      } catch (error) {
        await comment(`Could not check out the pull request branch \`${branch}\`: ${errorMessage(error)}`);
        await react("-1");
        return 1;
      }
    } else {
      baseBranch = await safeDefaultBranch(github);
      const unixTs = Math.floor(Date.now() / 1000);
      branch =
        trigger.number !== undefined
          ? `commandcode/issue-${trigger.number}-${unixTs}`
          : `commandcode/run-${unixTs}`;
      try {
        await git.checkoutBranch(workspace, baseBranch);
        await git.createBranch(workspace, branch);
      } catch (error) {
        await comment(`Could not prepare the branch \`${branch}\`: ${errorMessage(error)}`);
        await react("-1");
        return 1;
      }
    }

    // Configure agent credentials (BYOK) when provided.
    let envOverrides: Record<string, string> = {};
    try {
      const auth = await setupAgentAuth(
        {
          commandCodeApiKey: env("INPUT_COMMAND_CODE_API_KEY"),
          provider: env("INPUT_PROVIDER"),
          providerBaseUrl: env("INPUT_PROVIDER_BASE_URL"),
          providerApiKey: env("INPUT_PROVIDER_API_KEY"),
          model,
        },
        process.env,
      );
      envOverrides = auth.envOverrides;
    } catch (error) {
      await comment(`Failed to configure the agent credentials: ${errorMessage(error)}`);
      await react("-1");
      return 1;
    }

    const taskContext: TaskContext = {
      owner: trigger.owner,
      repo: trigger.repo,
      number: trigger.number ?? 0,
      isPullRequest: trigger.isPullRequest,
      title: trigger.title,
      body: trigger.body,
      comments,
      branch,
      task: trigger.prompt,
    };

    // 6) Implementer agent.
    const implementer = await runAgent({
      prompt: buildImplementerPrompt(taskContext),
      workspace,
      maxTurns,
      model: model || undefined,
      env: envOverrides,
    });
    if (implementer.result.subtype === "error") {
      await comment(
        `The implementer agent failed: ${summarize(implementer.result.error ?? implementer.result.finalText, "unknown error")}`,
      );
      await react("-1");
      return 1;
    }

    // 7) Verification command (never throws).
    let verifyOutput: string | null = null;
    let verifyFailed = false;
    if (verifyCommand) {
      console.log(`Running verification command: ${verifyCommand}`);
      const verification = await runCommand(workspace, verifyCommand);
      verifyOutput = truncate(verification.output, MAX_VERIFY_OUTPUT);
      verifyFailed = verification.exitCode !== 0;
    }

    // Diff stat for the reviewer (stages all files).
    let diffStat = "";
    try {
      diffStat = await git.diffStat(workspace);
    } catch (error) {
      console.warn("Could not compute the diff stat:", error);
    }

    // 8) Reviewer agent with a fresh session.
    let reviewer: AgentResult | null = null;
    if (reviewEnabled) {
      const reviewRun = await runAgent({
        prompt: buildReviewerPrompt(taskContext, { diffStat, verifyOutput }),
        workspace,
        maxTurns,
        model: model || undefined,
        env: envOverrides,
      });
      reviewer = reviewRun.result;
      if (reviewer.subtype === "error") {
        console.warn(`The reviewer agent failed (non-fatal): ${reviewer.error ?? "unknown error"}`);
      }
    }

    // 9) No changes -> report and stop.
    const changedFiles = await git.statusPorcelain(workspace);
    if (changedFiles.length === 0) {
      await comment(
        `No changes were produced.\n\n${summarize(implementer.result.finalText, "(the implementer returned no summary)")}`,
      );
      await react("rocket");
      return 0;
    }

    // 10) Commit and push.
    await git.configureUser(
      workspace,
      "commandcode-agent[bot]",
      "commandcode-agent[bot]@users.noreply.github.com",
    );
    await git.addAll(workspace);

    const subject =
      trigger.number !== undefined
        ? `commandcode: resolve #${trigger.number}`
        : "commandcode: apply agent changes";
    const commitMessage = `${subject}\n\n${truncate(
      summarize(implementer.result.finalText, "Changes produced by the Command Code agent."),
      2000,
    )}`;
    await git.commit(workspace, commitMessage);

    const pushUrl = `https://x-access-token:${token}@github.com/${trigger.owner}/${trigger.repo}.git`;
    await git.push(workspace, { url: pushUrl, branch });

    // 11) + 12) Open a PR for issues; the push already updated the PR branch otherwise.
    let prUrl: string | null = null;
    if (!trigger.isPullRequest) {
      const prTitle =
        trigger.number !== undefined
          ? `${trigger.title || firstLine(trigger.prompt)} (#${trigger.number})`
          : firstLine(trigger.prompt);

      const pull = await github.createPullRequest({
        title: prTitle,
        head: branch,
        base: baseBranch,
        body: buildPullRequestBody({
          number: trigger.number,
          task: trigger.prompt,
          implementer: implementer.result,
          verifyCommand,
          verifyOutput,
          verifyFailed,
          reviewer,
        }),
      });
      prUrl = pull.html_url;
    }

    // 13) Final report.
    await comment(
      buildReport({
        branch,
        isPullRequest: trigger.isPullRequest,
        prUrl,
        model,
        implementer: implementer.result,
        reviewer,
        startedAt,
        runUrl,
      }),
    );
    await react("rocket");
    return 0;
  } catch (error) {
    console.error("The commandcode run failed:", error);
    await comment(
      `The commandcode run failed:\n\n\`\`\`\n${truncate(errorMessage(error), MAX_PR_VERIFY_OUTPUT)}\n\`\`\``,
    );
    await react("-1");
    return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Unhandled error in commandcode-github-agent:", error);
    process.exitCode = 1;
  });
