import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRescueNotes,
  captureRescue,
  MAX_RESCUE_PATCH_BYTES,
  RESCUE_ARTIFACT_NAME,
  RESCUE_DIR_NAME,
  RESCUE_NOTES_FILE,
  RESCUE_PATCH_FILE,
  rescueDirectory,
  rescueNotesPath,
  rescuePatchPath,
  truncatePatch,
} from "../src/rescue";

function committedRepo(): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "cc-rescue-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "tester"], { cwd: dir });
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
  return { dir, baseSha };
}

describe("rescue artifact path construction", () => {
  it("places the rescue directory under the runner temp dir", () => {
    expect(rescueDirectory("/tmp/runner")).toBe(join("/tmp/runner", RESCUE_DIR_NAME));
  });

  it("falls back to the system temp dir when the runner provides none", () => {
    expect(rescueDirectory("")).toBe(join(tmpdir(), RESCUE_DIR_NAME));
    expect(rescueDirectory(undefined)).toBe(join(tmpdir(), RESCUE_DIR_NAME));
  });

  it("names the patch and the README inside the directory", () => {
    const dir = join("/tmp/runner", RESCUE_DIR_NAME);
    expect(rescuePatchPath(dir)).toBe(join(dir, RESCUE_PATCH_FILE));
    expect(rescueNotesPath(dir)).toBe(join(dir, RESCUE_NOTES_FILE));
  });

  it("uses the same artifact name the composite action uploads", () => {
    expect(RESCUE_ARTIFACT_NAME).toBe(RESCUE_DIR_NAME);
  });
});

describe("truncatePatch", () => {
  it("leaves a patch under the limit untouched", () => {
    expect(truncatePatch("diff --git a/x b/x\n", 1000)).toBe("diff --git a/x b/x\n");
  });

  it("cuts an oversized patch and marks where it was truncated", () => {
    const patch = "a".repeat(50);
    const result = truncatePatch(patch, 10);
    expect(result.startsWith("aaaaaaaaaa")).toBe(true);
    expect(result).toContain("truncated");
    expect(result).toContain("kept 10 of 50 bytes");
    expect(result.length).toBeLessThan(patch.length + 80);
  });

  it("bounds a patch exactly at the cap without a marker", () => {
    const patch = "a".repeat(MAX_RESCUE_PATCH_BYTES);
    expect(truncatePatch(patch)).toBe(patch);
  });
});

describe("buildRescueNotes", () => {
  const notes = buildRescueNotes({
    branch: "commandcode/issue-25-1790669535",
    baseSha: "1111111111111111111111111111111111111111",
    headSha: "2222222222222222222222222222222222222222",
    remote: "origin",
    isFork: false,
    reason: "remote rejected: workflows permission",
    truncated: false,
  });

  it("records what was captured and how to re-apply it", () => {
    expect(notes).toContain("commandcode/issue-25-1790669535");
    expect(notes).toContain("1111111111111111111111111111111111111111");
    expect(notes).toContain("2222222222222222222222222222222222222222");
    expect(notes).toContain("git fetch origin");
    expect(notes).toContain(`git am ${RESCUE_PATCH_FILE}`);
  });

  it("includes the scrubbed failure reason", () => {
    expect(notes).toContain("remote rejected: workflows permission");
  });

  it("notes a truncated patch and a fork target", () => {
    const truncated = buildRescueNotes({
      branch: "b",
      baseSha: "a",
      headSha: "c",
      remote: "https://github.com/fork/repo.git",
      isFork: true,
      reason: "",
      truncated: true,
    });
    expect(truncated).toContain("truncated with a marker");
    expect(truncated).toContain("fork pull request branch");
    expect(truncated).toContain("(no error message captured)");
  });

  it("fetches the fork remote, not origin, for a fork branch", () => {
    const notes = buildRescueNotes({
      branch: "b",
      baseSha: "a",
      headSha: "c",
      remote: "https://github.com/fork/repo.git",
      isFork: true,
      reason: "",
      truncated: false,
    });
    expect(notes).toContain("git fetch https://github.com/fork/repo.git");
    expect(notes).not.toContain("git fetch origin");
  });
});

describe("captureRescue", () => {
  it("captures the commit since the branch point, new files included", async () => {
    const { dir, baseSha } = committedRepo();
    writeFileSync(join(dir, "tracked.txt"), "one\ntwo\n");
    writeFileSync(join(dir, "added.txt"), "new\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "agent change"], { cwd: dir });

    const directory = mkdtempSync(join(tmpdir(), "cc-rescue-out-"));
    const result = await captureRescue({
      workspace: dir,
      directory,
      branch: "commandcode/issue-1-1",
      baseSha,
      remote: "origin",
      isFork: false,
      reason: "remote rejected",
    });

    expect(result.truncated).toBe(false);
    const patch = readFileSync(result.patchPath, "utf8");
    expect(patch).toContain("diff --git a/added.txt b/added.txt");
    expect(patch).toContain("+new");
    expect(patch).toContain("+two");

    const notes = readFileSync(rescueNotesPath(directory), "utf8");
    expect(notes).toContain("commandcode/issue-1-1");
    expect(notes).toContain("remote rejected");
  });

  it("falls back to the commit's parent when the branch point was not recorded", async () => {
    const { dir } = committedRepo();
    writeFileSync(join(dir, "added.txt"), "new\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "agent change"], { cwd: dir });

    const directory = mkdtempSync(join(tmpdir(), "cc-rescue-out-"));
    const result = await captureRescue({
      workspace: dir,
      directory,
      branch: "b",
      baseSha: "",
      remote: "origin",
      isFork: false,
      reason: "r",
    });
    expect(readFileSync(result.patchPath, "utf8")).toContain("added.txt");
  });
});
