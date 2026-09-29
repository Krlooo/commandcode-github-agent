/**
 * Rescue artifacts.
 *
 * A rejected push destroys the runner, and with it the only copy of the work:
 * no branch, no pull request, nothing to inspect. When the push fails the
 * harness writes the agent's commit as a patch (plus a short README) into a
 * directory the composite action uploads as a workflow artifact, so the work
 * survives the run.
 *
 * The path construction, the truncation and the README text are pure and unit
 * tested; {@link captureRescue} is the only part that shells out to git and
 * touches the filesystem.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "./git";

/** Directory (under the runner temp dir) the action uploads when a run failed. */
export const RESCUE_DIR_NAME = "commandcode-rescue";
/**
 * Name of the workflow artifact. The composite action's upload step, the
 * failure comment built here and the README all use this same name; keep them in
 * sync when changing it.
 */
export const RESCUE_ARTIFACT_NAME = "commandcode-rescue";
/** Upper bound for the patch written to the artifact (bytes). */
export const MAX_RESCUE_PATCH_BYTES = 5_000_000;
/** Patch file name inside the artifact. */
export const RESCUE_PATCH_FILE = "changes.patch";
/** README file name inside the artifact. */
export const RESCUE_NOTES_FILE = "README.md";

/**
 * Absolute path of the directory the action uploads. Falls back to the system
 * temp dir when the runner does not provide one (local runs, tests).
 */
export function rescueDirectory(runnerTemp: string | undefined): string {
  const base = runnerTemp !== undefined && runnerTemp.length > 0 ? runnerTemp : tmpdir();
  return join(base, RESCUE_DIR_NAME);
}

export function rescuePatchPath(directory: string): string {
  return join(directory, RESCUE_PATCH_FILE);
}

export function rescueNotesPath(directory: string): string {
  return join(directory, RESCUE_NOTES_FILE);
}

/**
 * Bounds the captured patch. A patch larger than `maxBytes` is cut and a visible
 * marker records how much was dropped, so an enormous diff is truncated instead
 * of uploaded without limit.
 */
export function truncatePatch(patch: string, maxBytes = MAX_RESCUE_PATCH_BYTES): string {
  const total = Buffer.byteLength(patch, "utf8");
  if (total <= maxBytes) return patch;
  const kept = Buffer.from(patch, "utf8").subarray(0, maxBytes).toString("utf8");
  return `${kept}\n\n# ...(patch truncated: kept ${maxBytes} of ${total} bytes)\n`;
}

export interface RescueNotesOptions {
  branch: string;
  baseSha: string;
  headSha: string;
  remote: string;
  isFork: boolean;
  /** The scrubbed push error, so the artifact never holds a credential. */
  reason: string;
  truncated: boolean;
}

/** The README written beside the patch, explaining what it is and how to apply it. */
export function buildRescueNotes(options: RescueNotesOptions): string {
  const lines: string[] = [];
  lines.push("# Command Code rescue artifact");
  lines.push("");
  lines.push(
    "The agent finished its work, but the push back to GitHub was rejected, so the",
  );
  lines.push(
    "change never reached a branch and would have been lost with the runner. This",
  );
  lines.push("artifact holds the commit as a patch you can apply by hand.");
  lines.push("");
  lines.push("## What was captured");
  lines.push("");
  lines.push(`- Branch the push targeted: \`${options.branch}\``);
  lines.push(`- Commit: \`${options.headSha}\``);
  lines.push(`- Branch point (the commit's parent): \`${options.baseSha}\``);
  lines.push(`- Push remote: \`${options.remote}\``);
  if (options.isFork) {
    lines.push("- The push targeted a fork pull request branch.");
  }
  lines.push("");
  lines.push("## How to re-apply");
  lines.push("");
  lines.push("Check out the branch point and apply the patch:");
  lines.push("");
  lines.push("```sh");
  // Fetch the remote the push targeted: for a fork that is the fork URL, and the
  // branch point only exists there, so fetching `origin` would not retrieve it.
  lines.push(`git fetch ${options.remote}`);
  lines.push(`git checkout ${options.baseSha}`);
  lines.push("git checkout -b commandcode-rescue");
  lines.push(`git am ${RESCUE_PATCH_FILE}`);
  lines.push("```");
  lines.push("");
  if (options.truncated) {
    lines.push(
      "The patch was larger than the artifact limit and is truncated with a marker at",
    );
    lines.push("the end; the omitted part of the change is not in this artifact.");
    lines.push("");
  }
  lines.push("## Why the push failed");
  lines.push("");
  lines.push("```");
  lines.push(options.reason.trim() || "(no error message captured)");
  lines.push("```");
  return lines.join("\n");
}

export interface CaptureRescueOptions {
  workspace: string;
  /** Directory to write into; use {@link rescueDirectory} to compute it. */
  directory: string;
  branch: string;
  baseSha: string;
  remote: string;
  isFork: boolean;
  /** The scrubbed push error. */
  reason: string;
}

export interface RescueResult {
  directory: string;
  patchPath: string;
  /** True when the patch exceeded {@link MAX_RESCUE_PATCH_BYTES} and was cut. */
  truncated: boolean;
}

/**
 * Writes the rescue patch and its README for a failed push. Called only on the
 * failure path, after the commit exists and the push has been rejected.
 */
export async function captureRescue(options: CaptureRescueOptions): Promise<RescueResult> {
  mkdirSync(options.directory, { recursive: true });

  // Fall back to the commit's parent when the branch point was not recorded
  // (the pipeline commits exactly once, so HEAD^ is the same point).
  const baseSha =
    options.baseSha.length > 0 ? options.baseSha : await git.revParse(options.workspace, "HEAD^");
  const patch = await git.formatPatch(options.workspace, baseSha);
  const truncated = Buffer.byteLength(patch, "utf8") > MAX_RESCUE_PATCH_BYTES;
  const patchPath = rescuePatchPath(options.directory);
  writeFileSync(patchPath, truncatePatch(patch), "utf8");
  writeFileSync(
    rescueNotesPath(options.directory),
    buildRescueNotes({
      branch: options.branch,
      baseSha,
      headSha: await git.revParse(options.workspace, "HEAD"),
      remote: options.remote,
      isFork: options.isFork,
      reason: options.reason,
      truncated,
    }),
    "utf8",
  );

  return { directory: options.directory, patchPath, truncated };
}
