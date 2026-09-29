import { describe, expect, it } from "vitest";
import type { AgentResult } from "../src/agent";
import { buildPullRequestBody, type PullRequestBodyOptions } from "../src/report";

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
