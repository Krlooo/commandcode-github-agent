/**
 * Command Code (`cmdc`) headless runner: NDJSON result parsing and process
 * spawning. No runtime dependencies: only node builtins.
 *
 * The prompt is piped through stdin (documented headless input method) instead
 * of argv: shell quoting of multi-word prompts is not portable, and stdin has
 * no argument-length limits.
 */

import { spawn } from "node:child_process";

const MAX_BUFFER = 64 * 1024 * 1024;
const STDERR_TAIL_LENGTH = 2000;

export interface AgentUsage {
  [key: string]: number;
}

export interface AgentResult {
  subtype: "success" | "error" | "max_turns";
  finalText: string;
  sessionId?: string;
  stopReason?: string;
  error?: string;
  usage?: AgentUsage;
}

export interface RunAgentOptions {
  prompt: string;
  workspace: string;
  maxTurns: number;
  model?: string;
  env?: Record<string, string>;
}

export interface RunAgentOutcome {
  result: AgentResult;
  exitCode: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUsage(value: unknown): AgentUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: AgentUsage = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw)) usage[key] = raw;
  }
  return usage;
}

function mapResultFrame(frame: Record<string, unknown>): AgentResult {
  const rawSubtype = frame["subtype"];
  const subtype: AgentResult["subtype"] =
    rawSubtype === "error" || rawSubtype === "max_turns" || rawSubtype === "success" ? rawSubtype : "success";

  const result: AgentResult = {
    subtype,
    finalText: typeof frame["finalText"] === "string" ? frame["finalText"] : "",
  };

  if (typeof frame["sessionId"] === "string") result.sessionId = frame["sessionId"];
  if (typeof frame["stopReason"] === "string") result.stopReason = frame["stopReason"];
  if (typeof frame["error"] === "string") result.error = frame["error"];

  const usage = parseUsage(frame["usage"]);
  if (usage) result.usage = usage;

  return result;
}

/**
 * Parses the NDJSON stream emitted by `cmdc --output-format json` and returns
 * the LAST `{"type":"result",...}` frame, or `null` when there is none.
 * Non-JSON lines and event frames are ignored.
 */
export function parseAgentStdout(stdout: string): AgentResult | null {
  if (!stdout) return null;

  let last: AgentResult | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isRecord(parsed)) continue;
    if (parsed["type"] !== "result") continue;

    last = mapResultFrame(parsed);
  }

  return last;
}

function tail(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(trimmed.length - max);
}

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function spawnAgent(
  binary: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; prompt: string },
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, exitCode });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_BUFFER) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      stderr += `\n${error.message}`;
      finish(1);
    });
    child.on("close", (code: number | null) => {
      finish(typeof code === "number" ? code : 1);
    });

    // Ignore EPIPE when the CLI closes stdin early (e.g. argument errors).
    child.stdin?.on("error", () => {});
    child.stdin?.end(`${options.prompt}\n`);
  });
}

/**
 * Runs the Command Code CLI headlessly against a workspace, with the prompt
 * piped through stdin. Never throws on a non-zero exit: the exit code is
 * returned instead.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentOutcome> {
  const binary = process.platform === "win32" ? "cmdc.cmd" : "cmdc";

  const args = [
    "-p",
    "--yolo",
    "--skip-onboarding",
    "--no-auto-update",
    "--output-format",
    "json",
    "--max-turns",
    String(options.maxTurns),
  ];
  if (options.model) args.push("-m", options.model);

  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };

  const { stdout, stderr, exitCode } = await spawnAgent(binary, args, {
    cwd: options.workspace,
    env,
    prompt: options.prompt,
  });

  const parsed = parseAgentStdout(stdout);
  if (parsed) return { result: parsed, exitCode };

  const stderrTail = tail(stderr, STDERR_TAIL_LENGTH);
  const result: AgentResult = {
    subtype: "error",
    finalText: "",
    error: stderrTail
      ? `agent produced no result frame (exit code ${exitCode}); stderr tail:\n${stderrTail}`
      : `agent produced no result frame (exit code ${exitCode})`,
  };

  return { result, exitCode };
}
