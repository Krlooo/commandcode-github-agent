/**
 * Reporting helpers: the pull request body, the final report comment and the
 * conversation answer. Pure string formatting, unit-testable apart from the
 * orchestrator.
 */

import type { AgentResult } from "./agent";
import type { RepairOutcome, RepairReport } from "./repair";

export const MAX_COMMENT_LENGTH = 60000;
export const MAX_PR_VERIFY_OUTPUT = 4000;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n...(truncated ${text.length - max} characters)`;
}

export function summarize(text: string, fallback: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export interface PullRequestBodyOptions {
  number: number | undefined;
  task: string;
  implementer: AgentResult;
  verifyCommand: string;
  verifyOutput: string | null;
  verifyFailed: boolean;
  /**
   * True when `verifyOutput` comes from the run after the reviewer pass. The
   * body states which run it describes so a `passed` result is never attributed
   * to a tree the reviewer changed afterwards.
   */
  verifyAfterReview: boolean;
  reviewer: AgentResult | null;
  /** What the bounded repair loop did, when one was configured. */
  repair?: RepairReport | null;
  /**
   * Paths that appeared after the implementer finished, typically build output
   * or caches left by the verification and review steps. Listed so they are not
   * committed silently.
   */
  leftoverFiles?: string[];
}

function repairOutcomeText(outcome: RepairOutcome): string {
  switch (outcome) {
    case "passed":
      return "the verification passed after the repair";
    case "attempts_exhausted":
      return "the attempt budget ran out";
    case "no_change":
      return "the last attempt produced no change to the working tree";
    case "disabled":
      return "repair is disabled";
  }
}

/**
 * A line stating what repair did, so a change that passed first time reads
 * differently from one that needed repair.
 */
export function repairSummary(repair: RepairReport): string {
  if (!repair.initialVerificationFailed) {
    return "The first verification passed; no repair attempt was needed.";
  }
  if (repair.attempts === 0) {
    return `The first verification failed; no repair attempt ran (${repairOutcomeText(repair.outcome)}).`;
  }
  const attempts = repair.attempts === 1 ? "1 repair attempt" : `${repair.attempts} repair attempts`;
  return `The first verification failed; the implementer ran ${attempts} and ${repairOutcomeText(repair.outcome)}.`;
}

function verificationPhase(options: PullRequestBodyOptions): string {
  if (options.verifyAfterReview) {
    return "This result is from the verification re-run after the reviewer pass.";
  }
  if (options.reviewer) {
    return "This result is from the verification run before the reviewer pass; it does not reflect the reviewer's edits.";
  }
  return "This result is from the verification run.";
}

export function buildPullRequestBody(options: PullRequestBodyOptions): string {
  const sections: string[] = [];

  sections.push("## Task");
  sections.push(options.task.trim() || "(no task text provided)");

  sections.push("## What changed");
  sections.push(summarize(options.implementer.finalText, "(the implementer returned no summary)"));

  sections.push("## Verification");
  if (options.verifyCommand) {
    sections.push(`Command: \`${options.verifyCommand}\``);
    sections.push(`Result: ${options.verifyFailed ? "failed" : "passed"}`);
    sections.push(verificationPhase(options));
    if (options.repair) sections.push(repairSummary(options.repair));
    sections.push("```");
    sections.push(
      truncate(summarize(options.verifyOutput ?? "", "(no output captured)"), MAX_PR_VERIFY_OUTPUT),
    );
    sections.push("```");
  } else {
    sections.push("not configured");
  }

  if (options.leftoverFiles && options.leftoverFiles.length > 0) {
    sections.push("## Files created during verification or review");
    sections.push(
      "These files appeared after the implementer finished and were committed with the change. Review them and remove any that do not belong:\n\n" +
        options.leftoverFiles.map((path) => `- ${path}`).join("\n"),
    );
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

export interface ReportOptions {
  branch: string;
  isPullRequest: boolean;
  prUrl: string | null;
  model: string;
  implementer: AgentResult;
  reviewer: AgentResult | null;
  startedAt: number;
  runUrl: string;
  /** Set when a configured subagent model could not be used. */
  subagentModelNote?: string;
  /** What the bounded repair loop did, when one was configured. */
  repair?: RepairReport | null;
  /** The verification command; empty when none is configured. */
  verifyCommand: string;
  /** Whether the final verification (after the reviewer pass) failed. */
  verifyFailed: boolean;
  /** Paths that appeared after the implementer finished (build output, caches). */
  leftoverFiles?: string[];
}

export function buildReport(options: ReportOptions): string {
  const lines: string[] = [];
  lines.push(`Command Code finished the task on branch \`${options.branch}\`.`);

  if (options.prUrl) lines.push(`Pull request: ${options.prUrl}`);
  else if (options.isPullRequest) lines.push("Changes were pushed to the pull request branch.");

  lines.push(`Model: ${options.model || "(default)"}`);

  if (options.subagentModelNote) lines.push(options.subagentModelNote);
  if (options.verifyCommand) {
    lines.push(`Verification: ${options.verifyFailed ? "failed" : "passed"}.`);
  }
  if (options.repair) lines.push(repairSummary(options.repair));
  if (options.leftoverFiles && options.leftoverFiles.length > 0) {
    lines.push(
      `Files appeared after the implementer finished (verification or review) and were committed: ${options.leftoverFiles.join(", ")}`,
    );
  }

  const sessions: string[] = [];
  if (options.implementer.sessionId) sessions.push(`implementer ${options.implementer.sessionId}`);
  if (options.reviewer?.sessionId) sessions.push(`reviewer ${options.reviewer.sessionId}`);
  if (sessions.length > 0) lines.push(`Sessions: ${sessions.join(", ")}`);

  lines.push(`Duration: ${formatDuration(Date.now() - options.startedAt)}`);
  lines.push(`Run: ${options.runUrl}`);

  return truncate(lines.join("\n"), MAX_COMMENT_LENGTH);
}

/**
 * The comment for a conversation turn: the agent's answer on its own.
 * Used when the task was a question and no files were changed.
 */
export function buildAnswerComment(result: AgentResult): string {
  return truncate(summarize(result.finalText, "(the agent returned no answer)"), MAX_COMMENT_LENGTH);
}
