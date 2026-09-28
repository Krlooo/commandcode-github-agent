import { describe, expect, it } from "vitest";
import {
  buildImplementerPrompt,
  buildReviewerPrompt,
  MAX_CONTEXT_COMMENTS,
  type TaskContext,
} from "../src/prompt";

function context(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    owner: "carlos",
    repo: "commandcode-github-agent",
    number: 12,
    isPullRequest: false,
    title: "Fix the flaky test",
    body: "The auth test fails on Windows.",
    comments: [
      { author: "reporter", body: "happens only in CI" },
      { author: "carlos", body: "please check the temp path" },
    ],
    branch: "commandcode/issue-12-1700000000",
    task: "fix the flaky test",
    ...overrides,
  };
}

describe("buildImplementerPrompt", () => {
  it("includes the task, repo identity and branch", () => {
    const prompt = buildImplementerPrompt(context());
    expect(prompt).toContain("carlos/commandcode-github-agent");
    expect(prompt).toContain("fix the flaky test");
    expect(prompt).toContain("commandcode/issue-12-1700000000");
  });

  it("includes issue context: title, body and comments", () => {
    const prompt = buildImplementerPrompt(context());
    expect(prompt).toContain("Fix the flaky test");
    expect(prompt).toContain("The auth test fails on Windows.");
    expect(prompt).toContain("happens only in CI");
    expect(prompt).toContain("@reporter");
  });

  it("instructs the agent not to push, branch or open PRs itself", () => {
    const prompt = buildImplementerPrompt(context());
    expect(prompt).toContain("do not create branches");
    expect(prompt).toContain("do not push");
    expect(prompt).toContain("do not open pull requests");
  });

  it("instructs the agent to run the project checks", () => {
    const prompt = buildImplementerPrompt(context());
    expect(prompt).toContain("run the project's checks");
  });

  it("caps the number of context comments", () => {
    const many = Array.from({ length: MAX_CONTEXT_COMMENTS + 10 }, (_, i) => ({
      author: `user${i}`,
      body: `comment ${i}`,
    }));
    const prompt = buildImplementerPrompt(context({ comments: many }));
    expect(prompt).toContain(`comment ${many.length - 1}`);
    expect(prompt).not.toContain("comment 0");
  });
});

describe("buildReviewerPrompt", () => {
  it("includes the diff stat and the verification evidence", () => {
    const prompt = buildReviewerPrompt(context(), {
      diffStat: " src/auth.ts | 12 ++++++------",
      verifyOutput: "Tests: 18 passed, 0 failed",
    });
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("18 passed");
  });

  it("states the reviewer must verify the requirement and fix gaps", () => {
    const prompt = buildReviewerPrompt(context(), { diffStat: "", verifyOutput: null });
    expect(prompt).toContain("fix");
    expect(prompt).toMatch(/not addressed|missing|incomplete/i);
  });

  it("works without verification output", () => {
    const prompt = buildReviewerPrompt(context(), { diffStat: "", verifyOutput: null });
    expect(prompt).not.toContain("18 passed");
    expect(prompt).toContain("no verification output");
  });
});
