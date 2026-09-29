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

/**
 * The environment variables the agent process is allowed to inherit.
 *
 * The agent runs with --yolo, so it must not see GitHub tokens, Actions
 * runtime/OIDC tokens or the action inputs: a prompt injection in issue text
 * could otherwise make it exfiltrate them. Everything needed to run node, npm,
 * git and the CLI is listed here; the model credentials are applied as
 * overrides on top.
 */
const AGENT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "CI",
  "USERPROFILE",
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
];

/** Builds the least-privilege environment for the agent process. */
export function agentEnv(
  source: Record<string, string | undefined>,
  overrides: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of AGENT_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) env[key] = value;
  return env;
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
      // Keep the most recent output: the final {"type":"result"} frame is always
      // last, so dropping the tail (rather than the head) never loses it.
      stdout = (stdout + chunk.toString("utf8")).slice(-MAX_BUFFER);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_BUFFER);
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
 * Extracts the model ids from `cmdc --list-models` output. Lines are
 * `id<padding>description`, id first; category headings, the header, the
 * trailing short-name usage examples and the decision-model section are not
 * model ids and are skipped.
 */
export function parseAvailableModels(output: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0) continue;
    if (line.startsWith("Pass the full id")) break;
    if (line.startsWith("Docs:")) break;
    if (line.startsWith("Decision models")) break;

    const match = /^(\S+)[ \t]{2,}\S/.exec(line);
    const id = match?.[1];
    if (!id) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

/**
 * Asks the CLI for the models available to the account (including BYOK provider
 * models when a provider is configured). Returns `null` when the listing could
 * not be produced, so callers fall back instead of failing.
 */
export async function listAvailableModels(
  env: Record<string, string> = {},
): Promise<string[] | null> {
  const binary = process.platform === "win32" ? "cmdc.cmd" : "cmdc";
  const { stdout, exitCode } = await spawnAgent(binary, ["--list-models"], {
    cwd: process.cwd(),
    env: agentEnv(process.env, env),
    prompt: "",
  });
  if (exitCode !== 0) return null;
  const models = parseAvailableModels(stdout);
  return models.length > 0 ? models : null;
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

  const env = agentEnv(process.env, options.env ?? {});

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
