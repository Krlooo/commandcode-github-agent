/**
 * The verification step: runs the configured `verify-command` in the workspace.
 *
 * The command runs the project's own test and build commands, which execute
 * code the agent just wrote, so it gets the same least-privilege environment as
 * the agent (see `agentEnv`) instead of inheriting the job environment. The
 * model credentials are deliberately left out: verification does not need them.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agentEnv } from "./agent";

const execFileAsync = promisify(execFile);
const MAX_SHELL_BUFFER = 64 * 1024 * 1024;

export interface VerificationResult {
  output: string;
  exitCode: number;
}

/**
 * The environment for the verification command: the agent allowlist with no
 * credential overrides, so GitHub, Actions and provider tokens are not
 * inherited.
 */
export function verificationEnv(
  source: Record<string, string | undefined>,
): Record<string, string> {
  return agentEnv(source, {});
}

export function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: process.env["ComSpec"] ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { file: "/bin/sh", args: ["-c", command] };
}

/**
 * Runs `command` in `cwd` with the restricted verification environment. Never
 * throws: a non-zero exit code is returned alongside the captured output.
 */
export async function runVerification(
  cwd: string,
  command: string,
  source: Record<string, string | undefined> = process.env,
): Promise<VerificationResult> {
  const { file, args } = shellInvocation(command);
  const env = verificationEnv(source);
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
      env,
      maxBuffer: MAX_SHELL_BUFFER,
    });
    return { output: [stdout, stderr].filter((part) => part.length > 0).join("\n"), exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown; message?: unknown };
    const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
    const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
    const message = typeof failure.message === "string" ? failure.message : "";
    const output = [stdout, stderr, message].filter((part) => part.length > 0).join("\n");
    const exitCode = typeof failure.code === "number" ? failure.code : 1;
    return { output, exitCode };
  }
}
