import { describe, expect, it } from "vitest";
import type { AgentResult } from "../src/agent";
import {
  buildPullRequestBody,
  buildReport,
  repairSummary,
  truncate,
  type PullRequestBodyOptions,
  type ReportOptions,
} from "../src/report";
import type { RepairReport } from "../src/repair";

function result(overrides: Partial<AgentResult> = {}): AgentResult {
  return { subtype: "success", finalText: "done", ...overrides };
}

function body(overrides: Partial<PullRequestBodyOptions> = {}): string {
  return buildPullRequestBody({
    number: 19,
    task: "harden the sandbox",
    implementer: result({ finalText: "implemented the fix" }),
    verifyCommand: "npm test",
    verifyOutput: "Tests: 30 passed",
    verifyFailed: false,
    verifyAfterReview: false,
    reviewer: result({ finalText: "looks good" }),
    ...overrides,
  });
}

describe("buildPullRequestBody verification reporting", () => {
  it("reports the final result and says it comes from the post-review re-run", () => {
    const text = body({
      verifyFailed: true,
      verifyAfterReview: true,
      verifyOutput: "1 failed",
    });
    expect(text).toContain("Result: failed");
    expect(text).toContain("1 failed");
    expect(text).toContain("re-run after the reviewer pass");
  });

  it("says the result predates the reviewer when there was no re-run", () => {
    const text = body({ verifyAfterReview: false });
    expect(text).toContain("Result: passed");
    expect(text).toContain("before the reviewer pass");
    expect(text).not.toContain("re-run after the reviewer pass");
  });

  it("does not attribute a result to a reviewer when review is disabled", () => {
    const text = body({ reviewer: null });
    expect(text).toContain("This result is from the verification run.");
    expect(text).not.toContain("reviewer pass");
  });

  it("reports when no verification command is configured", () => {
    const text = body({ verifyCommand: "" });
    expect(text).toContain("not configured");
    expect(text).not.toContain("Result:");
  });

  it("includes the reviewer summary and the closing clause", () => {
    const text = body();
    expect(text).toContain("looks good");
    expect(text).toContain("Closes #19");
  });
});

describe("repair reporting", () => {
  it("tells a first-time pass apart from a repaired change", () => {
    const firstTime = body({ repair: { initialVerificationFailed: false, attempts: 0, outcome: "passed" } });
    expect(firstTime).toContain("The first verification passed; no repair attempt was needed.");

    const repaired = body({ repair: { initialVerificationFailed: true, attempts: 1, outcome: "passed" } });
    expect(repaired).toContain("The first verification failed");
    expect(repaired).toContain("1 repair attempt");
    expect(repaired).toContain("verification passed after the repair");
  });

  it("reports a spent budget and a disabled repair honestly", () => {
    expect(repairSummary({ initialVerificationFailed: true, attempts: 2, outcome: "attempts_exhausted" })).toContain(
      "attempt budget ran out",
    );
    expect(repairSummary({ initialVerificationFailed: true, attempts: 1, outcome: "no_change" })).toContain(
      "no change to the working tree",
    );
    expect(repairSummary({ initialVerificationFailed: true, attempts: 0, outcome: "disabled" })).toContain(
      "no repair attempt ran",
    );
  });

  it("states the repair outcome in the verification section", () => {
    const text = body({ repair: { initialVerificationFailed: true, attempts: 1, outcome: "passed" } });
    expect(text.indexOf("The first verification failed")).toBeGreaterThan(text.indexOf("Result:"));
  });

  it("omits repair text when no repair was configured", () => {
    const text = body();
    expect(text).not.toContain("repair attempt");
  });
});

function report(overrides: Partial<ReportOptions> = {}): string {
  return buildReport({
    branch: "commandcode/issue-19-1700000000",
    isPullRequest: false,
    prUrl: "https://github.com/carlos/repo/pull/1",
    model: "some-model",
    implementer: result({ finalText: "implemented", sessionId: "implementer-session" }),
    reviewer: result({ finalText: "looks good" }),
    startedAt: Date.now(),
    runUrl: "https://github.com/carlos/repo/actions/runs/1",
    verifyCommand: "npm test",
    verifyFailed: false,
    ...overrides,
  });
}

describe("buildReport verification status", () => {
  it("states whether the final verification passed or failed", () => {
    expect(report({ verifyFailed: false })).toContain("Verification: passed.");
    expect(report({ verifyFailed: true })).toContain("Verification: failed.");
  });

  it("includes the repair outcome so a repaired change reads differently", () => {
    const text = report({
      repair: { initialVerificationFailed: true, attempts: 2, outcome: "attempts_exhausted" },
    });
    expect(text).toContain("attempt budget ran out");
  });

  it("omits the verification line when no command is configured", () => {
    const text = report({ verifyCommand: "", repair: null });
    expect(text).not.toContain("Verification:");
  });
});

describe("leftover file reporting", () => {
  it("lists the files created during verification or review in the pull request body", () => {
    const text = body({ leftoverFiles: ["coverage/index.html", "dist/index.js.map"] });
    expect(text).toContain("Files created during verification or review");
    expect(text).toContain("- coverage/index.html");
    expect(text).toContain("- dist/index.js.map");
  });

  it("omits the section when nothing was left behind", () => {
    expect(body()).not.toContain("Files created during verification or review");
  });

  it("names the files in the final report comment", () => {
    const text = report({ leftoverFiles: ["coverage/index.html"] });
    expect(text).toContain("after the implementer finished");
    expect(text).toContain("coverage/index.html");
  });
});

describe("truncate", () => {
  it("leaves short text untouched", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });

  it("marks where it cut a long text so the omission is visible", () => {
    const result = truncate("a".repeat(20), 5);
    expect(result.startsWith("aaaaa")).toBe(true);
    expect(result).toContain("...(truncated 15 characters)");
  });
});
