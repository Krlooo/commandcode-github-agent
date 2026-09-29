/**
 * Orchestrator (main entry).
 *
 * Trigger -> permission gate -> implementer agent -> verify -> reviewer agent
 * -> verify again -> commit/push -> pull request (or PR-branch update)
 * -> reply comment.
 *
 * Best-effort: it always reports, never leaves an unhandled rejection, and
 * returns 0 on success / 1 on failure.
 */

import { readFileSync } from "node:fs";
import { runAgent, listAvailableModels, parseTimeoutMinutes, type AgentResult } from "./agent";
import { downloadAttachments, extractAttachmentUrls } from "./attachments";
import { setupAgentAuth } from "./auth";
import { parseTrigger, repositoryIdentity, type Trigger } from "./event";
import * as git from "./git";
import { GitHubClient } from "./github";
import { DEFAULT_MENTIONS, parseMentions } from "./mentions";
import {
  buildFreshRepairPrompt,
  buildImplementerPrompt,
  buildRepairPrompt,
  buildReviewerPrompt,
  type RepairContext,
  type TaskContext,
} from "./prompt";
import { parseRepairAttempts, runRepairLoop, type RepairReport } from "./repair";
import {
  buildAnswerComment,
  buildPullRequestBody,
  buildPushFailureComment,
  buildReport,
  MAX_COMMENT_LENGTH,
  MAX_PR_VERIFY_OUTPUT,
  summarize,
  truncate,
} from "./report";
import {
  captureRescue,
  RESCUE_ARTIFACT_NAME,
  RESCUE_PATCH_FILE,
  rescueDirectory,
  type RescueResult,
} from "./rescue";
import { collectSecrets, scrubSecrets } from "./scrub";
import {
  configureSubagentModel,
  readRepositoryModel,
  SUBAGENT_AGENT_NAME,
} from "./subagent";
import { runVerification } from "./verify";

const MAX_VERIFY_OUTPUT = 20000;
/** Cap for the diff handed to the reviewer; a larger one is truncated with a marker. */
const MAX_REVIEW_DIFF = 40000;

function env(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? fallback : value;
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

function payloadAction(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "";
  const action = (payload as Record<string, unknown>)["action"];
  return typeof action === "string" ? action : "";
}

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? "commandcode agent changes";
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

  // Anything that can end up in a public comment or a log must be redacted: a
  // failed `git push` embeds the command line (and thus the auth header) in its
  // error message, which would otherwise leak the token into a comment.
  const secrets = collectSecrets([
    token,
    token ? git.basicAuthHeader(token) : undefined,
    env("INPUT_COMMAND_CODE_API_KEY"),
    env("COMMAND_CODE_API_KEY"),
    env("INPUT_PROVIDER_API_KEY"),
    env("CMD_AGENT_PROVIDER_KEY"),
    env("INPUT_AGENT_TOKEN"),
  ]);
  const logError = (message: string, error?: unknown): void => {
    const detail = error === undefined ? "" : ` ${errorMessage(error)}`;
    console.error(scrubSecrets(`${message}${detail}`, secrets));
  };

  let payload: unknown = {};
  if (eventPath) {
    try {
      payload = JSON.parse(readFileSync(eventPath, "utf8"));
    } catch (error) {
      logError("Could not read the GitHub event payload:", error);
      return 1;
    }
  }

  const mentions = parseMentions(env("INPUT_MENTIONS", DEFAULT_MENTIONS));
  const label = env("INPUT_LABEL").trim();

  // An `issues: assigned` trigger must mean "assigned to this app", so resolve
  // the login the token authenticates as unless one was configured. Resolution
  // goes through the GraphQL `viewer` because app installation tokens cannot
  // call `GET /app`. When it cannot be resolved, assignment events never fire
  // (the parser ignores them without a login) rather than matching any `*[bot]`.
  let botLogin = env("INPUT_BOT_LOGIN").trim();
  if (!botLogin && eventName === "issues" && payloadAction(payload) === "assigned") {
    const identity = repositoryIdentity(payload);
    if (identity) {
      try {
        botLogin =
          (await new GitHubClient({ token, owner: identity.owner, repo: identity.repo })
            .getAuthenticatedLogin()) ?? "";
      } catch (error) {
        logError(
          "Could not resolve the bot login for the assignment trigger; set the bot-login input to enable it:",
          error,
        );
      }
    }
  }

  const trigger: Trigger | null = parseTrigger(eventName, payload, mentions, { label, botLogin });
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
  const agentTimeoutMs = Math.round(parseTimeoutMinutes(env("INPUT_AGENT_TIMEOUT_MINUTES")) * 60_000);
  const verifyCommand = env("INPUT_VERIFY_COMMAND");
  const reviewEnabled = env("INPUT_REVIEW", "true").toLowerCase() === "true";
  const repairAttempts = parseRepairAttempts(env("INPUT_REPAIR_ATTEMPTS"));

  const runUrl = `${env("GITHUB_SERVER_URL", "https://github.com")}/${trigger.owner}/${trigger.repo}/actions/runs/${env("GITHUB_RUN_ID")}`;

  // Review comments carry their reactions on a different API route.
  const reactionKind: "issue" | "review" =
    trigger.kind === "pull_request_review_comment" ? "review" : "issue";

  let reactionId: number | undefined;

  const comment = async (message: string): Promise<void> => {
    const safe = scrubSecrets(message, secrets);
    if (trigger.number === undefined) {
      console.log(safe);
      return;
    }
    try {
      await github.postComment(trigger.number, truncate(safe, MAX_COMMENT_LENGTH));
    } catch (error) {
      logError("Failed to post a comment:", error);
    }
  };

  const react = async (content: string): Promise<void> => {
    if (trigger.commentId === undefined) return;
    if (reactionId !== undefined) {
      try {
        await github.deleteReaction(trigger.commentId, reactionId, reactionKind);
      } catch (error) {
        console.warn("Failed to remove the initial reaction:", error);
      }
      reactionId = undefined;
    }
    try {
      const reaction = await github.addReaction(trigger.commentId, content, reactionKind);
      reactionId = reaction.id;
    } catch (error) {
      console.warn("Failed to add a reaction:", error);
    }
  };

  // Removes the generated subagent agent file on every exit path.
  let cleanupSubagent = (): void => {};
  let subagentModelNote: string | undefined;
  // Set only when a subagent model was actually pinned, so the delegation rule
  // is added to the implementer prompt only when the pin is active.
  let subagentAgent: string | undefined;

  try {
    // 2) Permission gate: only collaborators with write/admin may trigger.
    let permission: "admin" | "write" | "read" | "none";
    try {
      permission = await github.getCollaboratorPermissionLevel(trigger.actor);
    } catch (error) {
      logError("Could not verify the commenter's permission:", error);
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
        const reaction = await github.addReaction(trigger.commentId, "eyes", reactionKind);
        reactionId = reaction.id;
      } catch (error) {
        console.warn("Failed to add the initial reaction:", error);
      }
    }

    // 4) Gather context: download any images attached to the trigger comment
    // and load the recent comments (both best effort).
    const attachmentPaths = await downloadAttachments(
      extractAttachmentUrls(trigger.commentBody ?? ""),
      token,
    );

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
    let isFork = false;
    let forkUrl: string | undefined;
    if (trigger.isPullRequest) {
      if (trigger.number === undefined) {
        logError("A pull request trigger without a number cannot be handled.");
        return 0;
      }
      const pull = await github.getPull(trigger.number);
      const expectedRepo = `${trigger.owner}/${trigger.repo}`;
      const headRepo = pull.head.repo?.full_name;
      if (!headRepo) {
        await comment(
          "The pull request head repository is missing; the fork may have been deleted.",
        );
        await react("-1");
        return 0;
      }
      isFork = headRepo !== expectedRepo;
      branch = pull.head.ref;
      try {
        await git.configureAuth(workspace, token);
        try {
          if (isFork) {
            forkUrl = `https://github.com/${headRepo}.git`;
            await git.fetchUrl(workspace, forkUrl, branch);
            await git.checkoutFetchHead(workspace, branch);
          } else {
            await git.fetchBranch(workspace, branch);
            await git.checkoutBranch(workspace, branch);
          }
        } finally {
          await git.unsetAuth(workspace);
        }
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

    // The commit the branch was carved from. A rescue patch is taken against it
    // if the push is later rejected; recording it here never changes the git
    // state a successful run leaves behind.
    let baseSha = "";
    try {
      baseSha = await git.revParse(workspace, "HEAD");
    } catch (error) {
      console.warn("Could not record the branch point for a possible rescue artifact:", error);
    }

    // Keep the write token out of `.git/config` while an agent session runs:
    // `actions/checkout` persists an `extraheader` credential by default, and
    // the implementer and reviewer run with `--yolo`, so a prompt injection
    // could read and exfiltrate it. Auth is re-added only transiently, around
    // the push (and the fetch on the pull request path), never across a session.
    await git.unsetAuth(workspace);

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

    // A read-only token for the agent: it lets the agent consult other issues
    // and pull requests with the gh CLI. The write token never enters its env.
    const agentReadToken = env("INPUT_AGENT_TOKEN");
    if (agentReadToken) envOverrides["GH_TOKEN"] = agentReadToken;

    // Pin a model for delegated subagents when one is configured and available.
    // An unavailable or unlisted model is a warning, never a failure: the run
    // continues and subagents inherit the session model. The generated agent
    // file must exist before the implementer session starts (files are
    // re-scanned each turn) and is removed again on every exit path.
    try {
      const subagent = await configureSubagentModel({
        workspace,
        models: {
          input: env("INPUT_SUBAGENT_MODEL"),
          repository: readRepositoryModel(workspace),
        },
        listModels: () => listAvailableModels(envOverrides),
        warn: (message) => console.warn(scrubSecrets(message, secrets)),
      });
      cleanupSubagent = subagent.cleanup;
      subagentModelNote = subagent.warning;
      if (subagent.model) subagentAgent = SUBAGENT_AGENT_NAME;
    } catch (error) {
      logError("Could not configure the subagent model (continuing):", error);
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
      attachments: attachmentPaths,
      ghReadAccess: agentReadToken.length > 0,
      subagentAgent,
    };

    // 6) Implementer agent.
    const implementer = await runAgent({
      prompt: buildImplementerPrompt(taskContext),
      workspace,
      maxTurns,
      model: model || undefined,
      env: envOverrides,
      timeoutMs: agentTimeoutMs,
    });
    if (implementer.result.subtype === "error") {
      await comment(
        `The implementer agent failed: ${summarize(implementer.result.error ?? implementer.result.finalText, "unknown error")}`,
      );
      await react("-1");
      return 1;
    }

    // 7) Conversation mode: with no changes, the task was a question. Publish the
    // answer and skip the verification, review and PR pipeline entirely.
    const publishAnswer = async (): Promise<number> => {
      await comment(buildAnswerComment(implementer.result));
      await react("rocket");
      return 0;
    };
    if ((await git.statusPorcelain(workspace)).length === 0) {
      return await publishAnswer();
    }
    // Snapshot the paths the implementer produced, so anything that appears
    // later (verification and review run the project's own commands) can be
    // named before `git add -A` commits it.
    const implementerPaths = await git.statusPorcelain(workspace);

    // 8) Verification command (never throws), with a restricted environment.
    let verifyOutput: string | null = null;
    let verifyFailed = false;
    if (verifyCommand) {
      console.log(`Running verification command: ${verifyCommand}`);
      const verification = await runVerification(workspace, verifyCommand);
      verifyOutput = truncate(verification.output, MAX_VERIFY_OUTPUT);
      verifyFailed = verification.exitCode !== 0;
    }

    // 8b) Bounded repair: hand a failed verification back to the implementer
    // before the reviewer pass, so a red tree is not pushed without a chance to
    // fix it. Only runs when the reviewer is enabled (a disabled reviewer keeps
    // the previous flow) and never when the repair budget is zero. Each attempt
    // resumes the previous session when a usable id is available, and the loop
    // stops as soon as verification passes or an attempt changes nothing.
    let repair: RepairReport | null = null;
    if (verifyCommand && reviewEnabled && repairAttempts > 0) {
      if (!verifyFailed) {
        repair = { initialVerificationFailed: false, attempts: 0, outcome: "passed" };
      } else {
        let lastVerifyOutput = verifyOutput ?? "";
        const loop = await runRepairLoop({
          maxAttempts: repairAttempts,
          initialSessionId: implementer.result.sessionId,
          fingerprint: () => git.workingTreeFingerprint(workspace),
          verify: async () => {
            const verification = await runVerification(workspace, verifyCommand);
            lastVerifyOutput = truncate(verification.output, MAX_VERIFY_OUTPUT);
            return { passed: verification.exitCode === 0, output: lastVerifyOutput };
          },
          runAttempt: async ({ attempt, resumeSessionId }) => {
            const repairContext: RepairContext = {
              verifyCommand,
              verifyOutput: lastVerifyOutput,
              attempt,
              maxAttempts: repairAttempts,
            };
            console.log(
              `Repair attempt ${attempt}/${repairAttempts}: ${
                resumeSessionId
                  ? `resuming implementer session ${resumeSessionId}`
                  : "starting a fresh session (no resumable session id)"
              }.`,
            );
            const repairRun = await runAgent({
              prompt: resumeSessionId
                ? buildRepairPrompt(repairContext)
                : buildFreshRepairPrompt(taskContext, repairContext),
              workspace,
              maxTurns,
              model: model || undefined,
              env: envOverrides,
              timeoutMs: agentTimeoutMs,
              resumeSessionId,
            });
            if (repairRun.result.subtype === "error") {
              console.warn(
                `Repair attempt ${attempt} failed: ${repairRun.result.error ?? "unknown error"}`,
              );
            }
            return { sessionId: repairRun.result.sessionId };
          },
        });
        repair = {
          initialVerificationFailed: true,
          attempts: loop.attempts,
          outcome: loop.outcome,
        };
        // The reviewer must see the tree as it stands after the repair: only
        // overwrite the recorded verification when an attempt actually ran.
        if (loop.output !== undefined) verifyOutput = loop.output;
        if (loop.passed !== undefined) verifyFailed = !loop.passed;
      }
    }

    // Diff for the reviewer (stages all files): the file-level stat plus the
    // change itself. The full diff is truncated with a visible marker, like the
    // verification output, so a large change is never silently dropped.
    let diffStat = "";
    let diff = "";
    try {
      diffStat = await git.diffStat(workspace);
    } catch (error) {
      console.warn("Could not compute the diff stat:", error);
    }
    try {
      diff = truncate(await git.stagedDiff(workspace), MAX_REVIEW_DIFF);
    } catch (error) {
      console.warn("Could not compute the diff:", error);
    }

    // 9) Reviewer agent with a fresh session.
    let reviewer: AgentResult | null = null;
    if (reviewEnabled) {
      const reviewRun = await runAgent({
        prompt: buildReviewerPrompt(taskContext, { diffStat, diff, verifyOutput }),
        workspace,
        maxTurns,
        model: model || undefined,
        env: envOverrides,
        timeoutMs: agentTimeoutMs,
      });
      reviewer = reviewRun.result;
      if (reviewer.subtype === "error") {
        console.warn(`The reviewer agent failed (non-fatal): ${reviewer.error ?? "unknown error"}`);
      }
    }

    // The reviewer may have adjusted the tree back to empty; answer then too.
    if ((await git.statusPorcelain(workspace)).length === 0) {
      return await publishAnswer();
    }

    // 9b) Re-run the verification after the reviewer pass: the reviewer is
    // allowed to change the tree, so the result reported below must describe the
    // final tree rather than a run the reviewer's edits invalidated. When the
    // reviewer is disabled the initial run already describes the final tree.
    let finalVerifyOutput = verifyOutput;
    let finalVerifyFailed = verifyFailed;
    let verifyAfterReview = false;
    if (verifyCommand && reviewEnabled) {
      console.log(`Re-running verification command after the reviewer pass: ${verifyCommand}`);
      const verification = await runVerification(workspace, verifyCommand);
      finalVerifyOutput = truncate(verification.output, MAX_VERIFY_OUTPUT);
      finalVerifyFailed = verification.exitCode !== 0;
      verifyAfterReview = true;
    }

    // 10) Commit and push. Surface anything that appeared after the implementer
    // finished before `git add -A` commits it: the verification and review steps
    // run the project's own commands and can leave build output, caches or
    // coverage behind. Reported, never deleted automatically.
    const leftoverPaths = git.addedPaths(implementerPaths, await git.statusPorcelain(workspace));
    if (leftoverPaths.length > 0) {
      console.warn(
        `Files appeared after the implementer finished (verification or review) and will be committed:\n${leftoverPaths
          .map((path) => `  ${path}`)
          .join("\n")}`,
      );
    }

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

    await git.configureAuth(workspace, token);
    let pushError: unknown;
    try {
      await git.push(workspace, isFork ? forkUrl : undefined, branch);
    } catch (error) {
      pushError = error;
    } finally {
      await git.unsetAuth(workspace);
    }

    // A rejected push would otherwise take the only copy of the work with the
    // runner. Capture the commit as a patch the composite action uploads as an
    // artifact, then point the failure comment at it. Success never reaches this
    // block, so the happy path is unchanged.
    if (pushError !== undefined) {
      const reason = scrubSecrets(errorMessage(pushError), secrets);
      let rescue: RescueResult | null = null;
      try {
        rescue = await captureRescue({
          workspace,
          directory: rescueDirectory(env("RUNNER_TEMP")),
          branch,
          baseSha,
          remote: isFork ? (forkUrl ?? "origin") : "origin",
          isFork,
          reason,
        });
      } catch (error) {
        logError("Could not capture the rejected push as a rescue artifact:", error);
      }
      await comment(
        buildPushFailureComment({
          branch,
          isFork,
          reason,
          artifactName: RESCUE_ARTIFACT_NAME,
          runUrl,
          captured: rescue !== null,
          truncated: rescue?.truncated ?? false,
          patchFile: RESCUE_PATCH_FILE,
        }),
      );
      await react("-1");
      return 1;
    }

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
          verifyOutput: finalVerifyOutput,
          verifyFailed: finalVerifyFailed,
          verifyAfterReview,
          reviewer,
          repair,
          leftoverFiles: leftoverPaths,
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
        subagentModelNote,
        repair,
        verifyCommand,
        verifyFailed: finalVerifyFailed,
        leftoverFiles: leftoverPaths,
      }),
    );
    await react("rocket");
    return 0;
  } catch (error) {
    logError("The commandcode run failed:", error);
    await comment(
      `The commandcode run failed:\n\n\`\`\`\n${truncate(errorMessage(error), MAX_PR_VERIFY_OUTPUT)}\n\`\`\``,
    );
    await react("-1");
    return 1;
  } finally {
    cleanupSubagent();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(
      "Unhandled error in commandcode-github-agent:",
      scrubSecrets(
        errorMessage(error),
        collectSecrets([
          env("GITHUB_TOKEN"),
          env("COMMAND_CODE_API_KEY"),
          env("INPUT_PROVIDER_API_KEY"),
          env("CMD_AGENT_PROVIDER_KEY"),
          env("INPUT_AGENT_TOKEN"),
        ]),
      ),
    );
    process.exitCode = 1;
  });
