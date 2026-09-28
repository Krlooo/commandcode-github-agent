import { describe, expect, it } from "vitest";
import { extractPrompt, parseTrigger } from "../src/event";

const repo = {
  name: "commandcode-github-agent",
  owner: { login: "carlos" },
};

const issue = {
  number: 12,
  title: "Fix the flaky test",
  body: "The auth test fails on Windows.",
  user: { login: "reporter" },
};

function issueCommentPayload(commentBody: string, isPullRequest = false) {
  return {
    action: "created",
    issue: {
      ...issue,
      ...(isPullRequest ? { pull_request: { url: "https://api.github.com/x" } } : {}),
    },
    comment: { id: 99, body: commentBody, user: { login: "carlos" } },
    repository: repo,
    sender: { login: "carlos" },
  };
}

describe("extractPrompt", () => {
  const mentions = ["/cmd", "/commandcode"];

  it("extracts the text after a leading mention", () => {
    expect(extractPrompt("/cmd fix the flaky test", mentions)).toBe("fix the flaky test");
  });

  it("extracts the text when the mention appears mid-sentence", () => {
    expect(extractPrompt("please /cmd fix the flaky test", mentions)).toBe("fix the flaky test");
  });

  it("supports alternative mentions", () => {
    expect(extractPrompt("/commandcode add a badge", mentions)).toBe("add a badge");
  });

  it("returns empty string when the mention has no task text", () => {
    expect(extractPrompt("/cmd", mentions)).toBe("");
  });

  it("returns null when no mention is present", () => {
    expect(extractPrompt("just a normal comment", mentions)).toBeNull();
  });

  it("does not treat a mention inside a word as a trigger", () => {
    expect(extractPrompt("my/cmd is broken", mentions)).toBeNull();
  });

  it("trims surrounding whitespace and keeps the rest of the body", () => {
    expect(extractPrompt("/cmd   do X\nand also Y  ", mentions)).toBe("do X\nand also Y");
  });
});

describe("parseTrigger", () => {
  const mentions = ["/cmd"];

  it("parses an issue_comment on an issue", () => {
    const trigger = parseTrigger("issue_comment", issueCommentPayload("/cmd fix it"), mentions);
    expect(trigger).toEqual({
      kind: "issue_comment",
      owner: "carlos",
      repo: "commandcode-github-agent",
      number: 12,
      isPullRequest: false,
      actor: "carlos",
      prompt: "fix it",
      commentId: 99,
      title: "Fix the flaky test",
      body: "The auth test fails on Windows.",
    });
  });

  it("flags issue_comment on a pull request", () => {
    const trigger = parseTrigger(
      "issue_comment",
      issueCommentPayload("/cmd fix it", true),
      mentions,
    );
    expect(trigger?.isPullRequest).toBe(true);
  });

  it("uses the issue body as prompt when the comment has no task text", () => {
    const trigger = parseTrigger("issue_comment", issueCommentPayload("/cmd"), mentions);
    expect(trigger?.prompt).toContain("The auth test fails on Windows.");
    expect(trigger?.prompt).toContain("Fix the flaky test");
  });

  it("returns null for comments without a mention", () => {
    expect(parseTrigger("issue_comment", issueCommentPayload("hello"), mentions)).toBeNull();
  });

  it("ignores non-created issue_comment actions", () => {
    const payload = { ...issueCommentPayload("/cmd fix it"), action: "edited" };
    expect(parseTrigger("issue_comment", payload, mentions)).toBeNull();
  });

  it("parses an opened issue into a task from title + body", () => {
    const payload = {
      action: "opened",
      issue: { ...issue, labels: [{ name: "commandcode" }] },
      repository: repo,
      sender: { login: "carlos" },
    };
    const trigger = parseTrigger("issues", payload, mentions);
    expect(trigger?.kind).toBe("issues");
    expect(trigger?.prompt).toContain("Fix the flaky test");
    expect(trigger?.prompt).toContain("The auth test fails on Windows.");
    expect(trigger?.commentId).toBeUndefined();
  });

  it("ignores closed issues", () => {
    const payload = {
      action: "closed",
      issue: { ...issue, labels: [] },
      repository: repo,
      sender: { login: "carlos" },
    };
    expect(parseTrigger("issues", payload, mentions)).toBeNull();
  });

  it("parses a labeled issue the same way as an opened one", () => {
    const payload = {
      action: "labeled",
      issue: { ...issue, labels: [{ name: "commandcode" }] },
      repository: repo,
      sender: { login: "carlos" },
    };
    const trigger = parseTrigger("issues", payload, mentions);
    expect(trigger?.kind).toBe("issues");
    expect(trigger?.prompt).toContain("Fix the flaky test");
  });

  it("parses a workflow_dispatch with a prompt input", () => {
    const payload = {
      inputs: { prompt: "add a CI badge" },
      repository: repo,
      sender: { login: "carlos" },
    };
    const trigger = parseTrigger("workflow_dispatch", payload, mentions);
    expect(trigger?.kind).toBe("workflow_dispatch");
    expect(trigger?.prompt).toBe("add a CI badge");
    expect(trigger?.number).toBeUndefined();
  });

  it("returns null for a workflow_dispatch without prompt input", () => {
    const payload = { inputs: {}, repository: repo, sender: { login: "carlos" } };
    expect(parseTrigger("workflow_dispatch", payload, mentions)).toBeNull();
  });

  it("returns null for unsupported events", () => {
    expect(parseTrigger("push", { repository: repo }, mentions)).toBeNull();
  });
});
