import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { basicAuthHeader, configureAuth, unsetAuth, workingTreeFingerprint } from "../src/git";

const execFileAsync = promisify(execFile);
const EXTRA_HEADER = "http.https://github.com/.extraheader";

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-git-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

async function readExtraHeader(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--local", "--get", EXTRA_HEADER], {
      cwd: dir,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

describe("git auth header lifecycle", () => {
  it("removes the credential an actions/checkout persist would leave in .git/config", async () => {
    const dir = tempRepo();
    // Simulate actions/checkout persisting the workflow token.
    await configureAuth(dir, "ghs_checkout_token");
    expect(await readExtraHeader(dir)).toBe(basicAuthHeader("ghs_checkout_token"));

    await unsetAuth(dir);
    expect(await readExtraHeader(dir)).toBeNull();
  });

  it("is safe when no header is configured", async () => {
    const dir = tempRepo();
    await expect(unsetAuth(dir)).resolves.toBeUndefined();
  });
});

describe("basicAuthHeader", () => {
  it("encodes x-access-token as a base64 basic header", () => {
    const token = "ghs_secret";
    const header = basicAuthHeader(token);
    expect(header).toBe(
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`,
    );
    expect(header.startsWith("AUTHORIZATION: basic ")).toBe(true);
  });
});

function committedRepo(): string {
  const dir = tempRepo();
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=tester", "commit", "-q", "-m", "initial"],
    { cwd: dir },
  );
  return dir;
}

describe("workingTreeFingerprint", () => {
  it("is stable when nothing changes and changes when a file is edited", async () => {
    const dir = committedRepo();
    const first = await workingTreeFingerprint(dir);
    expect(await workingTreeFingerprint(dir)).toBe(first);

    writeFileSync(join(dir, "tracked.txt"), "two\n");
    expect(await workingTreeFingerprint(dir)).not.toBe(first);
  });

  it("includes untracked files and leaves the index unstaged", async () => {
    const dir = committedRepo();
    const first = await workingTreeFingerprint(dir);

    writeFileSync(join(dir, "new.txt"), "added\n");
    expect(await workingTreeFingerprint(dir)).not.toBe(first);

    const { stdout } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: dir });
    expect(stdout.trim()).toBe("");
  });
});
