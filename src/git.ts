/**
 * Thin, promise-based wrappers over the `git` CLI.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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

/** Fetches `ref` from an explicit remote URL (e.g. a fork's HTTPS remote). */
export async function fetchUrl(cwd: string, url: string, ref: string): Promise<void> {
  await git(cwd, ["fetch", url, ref]);
}

/** Checks out `FETCH_HEAD` into `branch`, resetting it if it already exists. */
export async function checkoutFetchHead(cwd: string, branch: string): Promise<void> {
  await git(cwd, ["checkout", "-B", branch, "FETCH_HEAD"]);
}

export async function addAll(cwd: string): Promise<void> {
  await git(cwd, ["add", "-A"]);
}

export async function commit(cwd: string, message: string): Promise<void> {
  await git(cwd, ["commit", "-m", message]);
}

/**
 * Builds the Git HTTP authorization header for a GitHub token. Exposed so the
 * caller can redact this exact header from any text (see `scrubSecrets`).
 */
export function basicAuthHeader(token: string): string {
  const encoded = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return `AUTHORIZATION: basic ${encoded}`;
}

/**
 * Configures the local git auth header for github.com. This REPLACES any header
 * left behind by `actions/checkout` (persist-credentials), which would otherwise
 * shadow it with the workflow GITHUB_TOKEN, and keeps the token out of argv.
 */
export async function configureAuth(cwd: string, token: string): Promise<void> {
  await git(cwd, [
    "config",
    "--local",
    "http.https://github.com/.extraheader",
    basicAuthHeader(token),
  ]);
}

/** Removes the local auth header; safe when none is configured. */
export async function unsetAuth(cwd: string): Promise<void> {
  try {
    await git(cwd, ["config", "--local", "--unset-all", "http.https://github.com/.extraheader"]);
  } catch {
    // no header was configured
  }
}

/** Pushes the current HEAD to `url` (defaults to `origin`) as `branch` (auth via `configureAuth`). */
export async function push(cwd: string, url: string | undefined, branch: string): Promise<void> {
  await git(cwd, ["push", url ?? "origin", `HEAD:refs/heads/${branch}`]);
}

export async function statusPorcelain(cwd: string): Promise<string[]> {
  // `--untracked-files=all` lists every file inside an untracked directory
  // rather than collapsing it to a single `dir/` entry, so leftovers inside a
  // new build or coverage directory are named individually.
  const output = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3).trim())
    .filter((path) => path.length > 0);
}

/**
 * Paths present in `after` but not in `before`, in `after` order and without
 * duplicates. Used to name the files that appeared while verification and review
 * ran, so they are reported before `git add -A` commits them.
 */
export function addedPaths(before: string[], after: string[]): string[] {
  const known = new Set(before);
  const added: string[] = [];
  for (const path of after) {
    if (known.has(path)) continue;
    known.add(path);
    added.push(path);
  }
  return added;
}

export async function diffStat(cwd: string): Promise<string> {
  // Stage everything first so untracked files are included in the captured diff.
  await addAll(cwd);
  const output = await git(cwd, ["diff", "--cached", "--stat"]);
  // Restore the index (mixed reset, working tree untouched) so `git restore`
  // semantics for the reviewer are the same as before the harness ran.
  await git(cwd, ["reset"]);
  return output.trim();
}

/**
 * The complete staged diff, untracked files included (stages everything first,
 * then restores the index like {@link diffStat}). This is the change itself, not
 * just the file-level summary, so the reviewer can spot removals and modified
 * lines the stat would hide.
 */
export async function stagedDiff(cwd: string): Promise<string> {
  await addAll(cwd);
  try {
    const output = await git(cwd, ["diff", "--cached"]);
    return output.trim();
  } finally {
    await git(cwd, ["reset"]);
  }
}

/**
 * A hash of the complete staged diff, untracked files included. Used to detect
 * whether a repair attempt touched the working tree at all: two equal
 * fingerprints mean the attempt changed nothing.
 */
export async function workingTreeFingerprint(cwd: string): Promise<string> {
  await addAll(cwd);
  try {
    const output = await git(cwd, ["diff", "--cached"]);
    return createHash("sha256").update(output).digest("hex");
  } finally {
    await git(cwd, ["reset"]);
  }
}

export async function currentBranch(cwd: string): Promise<string> {
  const output = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return output.trim();
}
