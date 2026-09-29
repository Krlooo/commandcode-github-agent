import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REPAIR_ATTEMPTS,
  decideRepair,
  isResumableSessionId,
  parseRepairAttempts,
  runRepairLoop,
  type RepairLoopOptions,
} from "../src/repair";

describe("parseRepairAttempts", () => {
  it("defaults to one attempt when unset or blank", () => {
    expect(parseRepairAttempts(undefined)).toBe(DEFAULT_REPAIR_ATTEMPTS);
    expect(DEFAULT_REPAIR_ATTEMPTS).toBe(1);
    expect(parseRepairAttempts("")).toBe(1);
    expect(parseRepairAttempts("   ")).toBe(1);
  });

  it("accepts zero, which disables repair", () => {
    expect(parseRepairAttempts("0")).toBe(0);
  });

  it("parses a positive integer", () => {
    expect(parseRepairAttempts("3")).toBe(3);
    expect(parseRepairAttempts(" 2 ")).toBe(2);
  });

  it("floors a fractional value", () => {
    expect(parseRepairAttempts("2.9")).toBe(2);
  });

  it("falls back on a non-numeric or negative value", () => {
    expect(parseRepairAttempts("abc")).toBe(1);
    expect(parseRepairAttempts("-1")).toBe(1);
  });

  it("honours a custom fallback", () => {
    expect(parseRepairAttempts(undefined, 4)).toBe(4);
    expect(parseRepairAttempts("nonsense", 4)).toBe(4);
  });
});

describe("decideRepair", () => {
  it("stops with disabled when the budget is zero", () => {
    expect(decideRepair({ maxAttempts: 0, attemptsUsed: 0, lastAttemptChangedTree: true })).toEqual({
      run: false,
      reason: "disabled",
    });
  });

  it("runs while attempts remain and the tree keeps changing", () => {
    expect(decideRepair({ maxAttempts: 3, attemptsUsed: 1, lastAttemptChangedTree: true })).toEqual({
      run: true,
    });
  });

  it("stops with attempts_exhausted once the budget is spent", () => {
    expect(decideRepair({ maxAttempts: 2, attemptsUsed: 2, lastAttemptChangedTree: true })).toEqual({
      run: false,
      reason: "attempts_exhausted",
    });
  });

  it("stops with no_change when the last attempt did not touch the tree", () => {
    expect(decideRepair({ maxAttempts: 5, attemptsUsed: 1, lastAttemptChangedTree: false })).toEqual({
      run: false,
      reason: "no_change",
    });
  });
});

describe("isResumableSessionId", () => {
  it("accepts a full session id and a unique prefix", () => {
    expect(isResumableSessionId("9f4e1c0a-1234-4abc-8def-0123456789ab")).toBe(true);
    expect(isResumableSessionId("3f9a")).toBe(true);
  });

  it("rejects a missing, blank or placeholder id", () => {
    expect(isResumableSessionId(undefined)).toBe(false);
    expect(isResumableSessionId("")).toBe(false);
    expect(isResumableSessionId("   ")).toBe(false);
    expect(isResumableSessionId("undefined")).toBe(false);
    expect(isResumableSessionId("null")).toBe(false);
  });

  it("rejects a path or a too-short value", () => {
    expect(isResumableSessionId("sessions/abc.jsonl")).toBe(false);
    expect(isResumableSessionId("abc")).toBe(false);
  });
});

function fingerprint(seq: string[]): () => Promise<string> {
  let index = 0;
  return async () => {
    const value = seq[Math.min(index, seq.length - 1)] ?? "f";
    index += 1;
    return value;
  };
}

function options(overrides: Partial<RepairLoopOptions> = {}): RepairLoopOptions {
  return {
    maxAttempts: 1,
    fingerprint: fingerprint(["a", "b", "c", "d", "e", "f"]),
    verify: async () => ({ passed: true, output: "ok" }),
    runAttempt: async () => ({}),
    ...overrides,
  };
}

describe("runRepairLoop", () => {
  it("does nothing when repair is disabled", async () => {
    const runAttempt = vi.fn(async () => ({}));
    const verify = vi.fn(async () => ({ passed: false, output: "fail" }));
    const result = await runRepairLoop(
      options({ maxAttempts: 0, runAttempt, verify, fingerprint: fingerprint(["a", "a"]) }),
    );
    expect(result).toEqual({ attempts: 0, outcome: "disabled" });
    expect(runAttempt).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("stops as soon as verification passes, without spending the whole budget", async () => {
    const runAttempt = vi.fn(async () => ({}));
    const verify = vi.fn(async () => ({ passed: true, output: "green" }));
    const result = await runRepairLoop(
      options({ maxAttempts: 5, runAttempt, verify, fingerprint: fingerprint(["a", "b"]) }),
    );
    expect(result).toEqual({ attempts: 1, outcome: "passed", passed: true, output: "green" });
    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("stops with attempts_exhausted when the budget runs out and it still fails", async () => {
    const runAttempt = vi.fn(async () => ({}));
    const verify = vi.fn(async () => ({ passed: false, output: "still failing" }));
    const result = await runRepairLoop(
      options({
        maxAttempts: 2,
        runAttempt,
        verify,
        fingerprint: fingerprint(["a", "b", "c", "d", "e"]),
      }),
    );
    expect(result.attempts).toBe(2);
    expect(result.outcome).toBe("attempts_exhausted");
    expect(result.passed).toBeUndefined();
    expect(runAttempt).toHaveBeenCalledTimes(2);
  });

  it("stops without retrying when an attempt leaves the tree unchanged", async () => {
    const runAttempt = vi.fn(async () => ({}));
    const verify = vi.fn(async () => ({ passed: false, output: "unchanged" }));
    const result = await runRepairLoop(
      options({
        maxAttempts: 5,
        runAttempt,
        verify,
        fingerprint: fingerprint(["same", "same", "other", "other"]),
      }),
    );
    expect(result.attempts).toBe(1);
    expect(result.outcome).toBe("no_change");
    expect(runAttempt).toHaveBeenCalledTimes(1);
  });

  it("resumes the previous session id and chains each attempt off the last", async () => {
    const resumeSessionIds: Array<string | undefined> = [];
    const runAttempt = vi.fn(async ({ resumeSessionId }: { resumeSessionId: string | undefined }) => {
      resumeSessionIds.push(resumeSessionId);
      return { sessionId: "next-session-id" };
    });
    await runRepairLoop(
      options({
        maxAttempts: 2,
        initialSessionId: "9f4e1c0a-aaaa-bbbb-cccc-dddddddddddd",
        runAttempt,
        verify: async () => ({ passed: false, output: "fail" }),
        fingerprint: fingerprint(["a", "b", "c", "d", "e"]),
      }),
    );
    expect(resumeSessionIds).toEqual([
      "9f4e1c0a-aaaa-bbbb-cccc-dddddddddddd",
      "next-session-id",
    ]);
  });

  it("starts a fresh session when the previous id is not resumable", async () => {
    const resumeSessionIds: Array<string | undefined> = [];
    await runRepairLoop(
      options({
        maxAttempts: 1,
        initialSessionId: "not/a/session",
        runAttempt: async ({ resumeSessionId }) => {
          resumeSessionIds.push(resumeSessionId);
          return {};
        },
        verify: async () => ({ passed: false, output: "fail" }),
        fingerprint: fingerprint(["a", "b"]),
      }),
    );
    expect(resumeSessionIds).toEqual([undefined]);
  });
});
