/**
 * Bounded repair of a failed verification.
 *
 * The pipeline runs the verification command after the implementer pass. When
 * that command fails, the failure is handed back to the implementer for a
 * limited number of attempts instead of moving on with a red tree. The loop
 * stops as soon as the tree verifies green, when the attempt budget is spent,
 * or when an attempt did not touch the working tree (the agent cannot fix it,
 * so retrying would only burn tokens).
 *
 * The decision is kept pure and the loop takes its side effects as injected
 * callbacks, so both are unit-testable without a CLI or a real repository.
 */

/** Default number of repair attempts, matching the `repair-attempts` input. */
export const DEFAULT_REPAIR_ATTEMPTS = 1;

/**
 * Parses the `repair-attempts` input into a non-negative number of attempts.
 * Returns the fallback when the value is unset, blank, not a number or
 * negative. Zero is a valid value and disables repair.
 */
export function parseRepairAttempts(
  value: string | undefined,
  fallback = DEFAULT_REPAIR_ATTEMPTS,
): number {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  const attempts = Number(trimmed);
  if (!Number.isFinite(attempts) || attempts < 0) return fallback;
  return Math.floor(attempts);
}

/** Why the repair loop stopped. */
export type RepairOutcome = "disabled" | "passed" | "attempts_exhausted" | "no_change";

/** Reasons that stop the loop without the tree verifying green. */
export type RepairStopReason = Exclude<RepairOutcome, "passed">;

export interface RepairDecisionInput {
  /** Configured attempts; zero or less disables repair. */
  maxAttempts: number;
  /** Attempts already spent. */
  attemptsUsed: number;
  /** Whether the most recent attempt changed the working tree. */
  lastAttemptChangedTree: boolean;
}

export type RepairDecision = { run: true } | { run: false; reason: RepairStopReason };

/**
 * Decides whether another repair attempt may run. A no-change attempt is the
 * most specific stop reason, so it is reported before an exhausted budget that
 * happens to coincide with it.
 */
export function decideRepair(input: RepairDecisionInput): RepairDecision {
  if (input.maxAttempts <= 0) return { run: false, reason: "disabled" };
  if (input.attemptsUsed > 0 && !input.lastAttemptChangedTree) {
    return { run: false, reason: "no_change" };
  }
  if (input.attemptsUsed >= input.maxAttempts) {
    return { run: false, reason: "attempts_exhausted" };
  }
  return { run: true };
}

/** Session ids are UUIDs; a unique prefix is enough, but never a path or `undefined`. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Whether a session id from a previous result frame can be used with the CLI's
 * `--resume`. The field is optional on error results, so an absent or malformed
 * id must fall back to a fresh session instead of being passed through.
 */
export function isResumableSessionId(id: string | undefined): boolean {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  if (trimmed.length < 4 || trimmed.length > 128) return false;
  if (trimmed.toLowerCase() === "undefined" || trimmed.toLowerCase() === "null") return false;
  if (trimmed.includes("/") || trimmed.includes("\\")) return false;
  return SESSION_ID_PATTERN.test(trimmed);
}

export interface RepairAttemptParams {
  /** 1-based attempt number. */
  attempt: number;
  /** Session id to resume, or undefined to start a fresh session. */
  resumeSessionId: string | undefined;
}

export interface RepairLoopOptions {
  maxAttempts: number;
  /** Session id carried by the implementer result, candidate for the first resume. */
  initialSessionId?: string;
  /** Fingerprint of the working tree; equal before/after means the attempt changed nothing. */
  fingerprint: () => Promise<string>;
  /** Runs the verification command and reports whether it passed. */
  verify: () => Promise<{ passed: boolean; output: string }>;
  /** Runs one repair attempt, returning the session id for chaining the next one. */
  runAttempt: (params: RepairAttemptParams) => Promise<{ sessionId?: string }>;
}

export interface RepairLoopResult {
  /** Attempts actually spent. */
  attempts: number;
  outcome: RepairOutcome;
  /** Whether the last verification passed; undefined when no attempt ran. */
  passed?: boolean;
  /** Output of the last verification run; undefined when no attempt ran. */
  output?: string;
}

/**
 * Runs the bounded repair loop. The first attempt resumes the implementer's
 * session when a usable id is available, and each later attempt chains off the
 * session id returned by the attempt before it; when no id is usable the
 * attempt runs as a fresh session. Verification is re-run after every attempt
 * and the loop returns as soon as it passes.
 */
export async function runRepairLoop(options: RepairLoopOptions): Promise<RepairLoopResult> {
  if (options.maxAttempts <= 0) {
    return { attempts: 0, outcome: "disabled" };
  }

  let attempts = 0;
  let lastAttemptChangedTree = true;
  let sessionId = options.initialSessionId;

  while (true) {
    const decision = decideRepair({
      maxAttempts: options.maxAttempts,
      attemptsUsed: attempts,
      lastAttemptChangedTree,
    });
    if (!decision.run) {
      return { attempts, outcome: decision.reason };
    }

    const before = await options.fingerprint();
    const resumeSessionId = isResumableSessionId(sessionId) ? sessionId : undefined;
    const result = await options.runAttempt({ attempt: attempts + 1, resumeSessionId });
    attempts += 1;
    const after = await options.fingerprint();
    lastAttemptChangedTree = before !== after;
    sessionId = result.sessionId;

    const verification = await options.verify();
    if (verification.passed) {
      return { attempts, outcome: "passed", passed: true, output: verification.output };
    }
  }
}

/** What the pull request body and the final report say about repair. */
export interface RepairReport {
  /** True when the verification run right after the implementer failed. */
  initialVerificationFailed: boolean;
  /** Repair attempts actually spent. */
  attempts: number;
  outcome: RepairOutcome;
}
