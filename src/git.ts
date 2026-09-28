/**
 * Thin, promise-based wrappers over the `git` CLI.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
}

export async function configureUser(cwd: string, name: string, email: string): Promise<void> {
  await git(cwd, ["config", "user.name", name]);
  await git(cwd, ["config", "user.email", email]);
}

export async function checkoutBranch(cwd: string, name: string): Promise<void> {
  await git(cwd, ["checkout", name]);
}

export async function createBranch(cwd: string, name: string): Promise<void> {
  await git(cwd, ["checkout", "-b", name]);
}

export async function fetchBranch(cwd: string, ref: string): Promise<void> {
  await git(cwd, ["fetch", "origin", ref]);
}

export async function addAll(cwd: string): Promise<void> {
  await git(cwd, ["add", "-A"]);
}

export async function commit(cwd: string, message: string): Promise<void> {
  await git(cwd, ["commit", "-m", message]);
}

export async function push(cwd: string, options: { url: string; branch: string }): Promise<void> {
  await git(cwd, ["push", options.url, `HEAD:refs/heads/${options.branch}`]);
}

export async function statusPorcelain(cwd: string): Promise<string[]> {
  const output = await git(cwd, ["status", "--porcelain"]);
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3).trim())
    .filter((path) => path.length > 0);
}

export async function diffStat(cwd: string): Promise<string> {
  // Stage everything first so untracked files are included in the captured diff.
  await addAll(cwd);
  const output = await git(cwd, ["diff", "--cached", "--stat"]);
  return output.trim();
}

export async function currentBranch(cwd: string): Promise<string> {
  const output = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return output.trim();
}
