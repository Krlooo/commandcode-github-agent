/**
 * Configurable model for delegated subagents.
 *
 * Command Code pins a subagent's model through the `model` field of a custom
 * agent file, so this module resolves the desired model (the action input, then
 * a repository-committed default), checks it against the models the CLI reports
 * as available, and writes `.commandcode/agents/<name>.md` when it can be used.
 *
 * The generated file is hidden from git and removed after the run, so it can
 * neither leak into a commit nor pin a model on a later run.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Identifier of the generated subagent (not a reserved Command Code name). */
export const SUBAGENT_AGENT_NAME = "commandcode-subagent";
/** Workspace-relative path of the generated agent file. */
export const SUBAGENT_AGENT_PATH = `.commandcode/agents/${SUBAGENT_AGENT_NAME}.md`;
/** Workspace-relative path of the repository-committed default, a plain model id. */
export const REPOSITORY_MODEL_FILE = ".commandcode/subagent-model";

export interface SubagentModelInput {
  /** Value of the `subagent-model` action input. */
  input?: string;
  /** Value committed in {@link REPOSITORY_MODEL_FILE}, if any. */
  repository?: string;
}

export interface SubagentModelSetup {
  /** The model pinned in the generated agent file, when one was written. */
  model?: string;
  /** Absolute path of the generated agent file, when one was written. */
  filePath?: string;
  /** Reason a configured model was not used, for logging and the final report. */
  warning?: string;
  /** Removes the generated file and its git exclusion. Safe to call when nothing was written. */
  cleanup: () => void;
}

/**
 * Reads the repository-committed default model from
 * {@link REPOSITORY_MODEL_FILE}. Returns the first non-empty, non-comment line,
 * or `undefined` when the file is missing, empty or unreadable.
 */
export function readRepositoryModel(workspace: string): string | undefined {
  const file = join(workspace, REPOSITORY_MODEL_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const value = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, "").trim())
      .find((line) => line.length > 0);
    return value && value.toLowerCase() !== "inherit" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the listed model id `requested` refers to, matching either the full id
 * or the short name after the last `/` (both accepted by `cmdc --model`). The id
 * the CLI listed is returned rather than the caller's text, because the agent
 * file's `model` field is resolved against the catalog's canonical ids: a short
 * name that works on the command line is not necessarily a valid `model` value.
 * The comparison is case-insensitive because the CLI lowercases the listing.
 */
export function resolveAvailableModel(requested: string, available: string[]): string | undefined {
  const wanted = requested.trim().toLowerCase();
  if (wanted.length === 0) return undefined;
  for (const id of available) {
    const listed = id.trim();
    const lower = listed.toLowerCase();
    if (lower === wanted || lower.slice(lower.lastIndexOf("/") + 1) === wanted) return listed;
  }
  return undefined;
}

/**
 * True when {@link resolveAvailableModel} finds a match, i.e. the requested model
 * is available to the account.
 */
export function isModelAvailable(requested: string, available: string[]): boolean {
  return resolveAvailableModel(requested, available) !== undefined;
}

function agentFileContents(model: string): string {
  return [
    "---",
    `name: ${SUBAGENT_AGENT_NAME}`,
    'description: "General-purpose worker for tasks the main agent delegates. Use it when you hand implementation, exploration or research to a subagent."',
    `model: ${model}`,
    'tools: "*"',
    "---",
    "",
    "You are a general-purpose subagent working inside this repository. Complete the task you are given, follow the repository's own conventions, and finish with a concise summary of what you did.",
    "",
  ].join("\n");
}

/**
 * Adds `/relativePath` to `.git/info/exclude` so the generated agent file stays
 * out of `git status`, `git diff` and `git add`. Returns true when the entry was
 * added (and should therefore be removed on cleanup). Best effort: no git
 * directory means no exclusion.
 */
function addGitExclude(workspace: string, relativePath: string): boolean {
  const infoDir = join(workspace, ".git", "info");
  if (!existsSync(infoDir)) return false;
  const file = join(infoDir, "exclude");
  const entry = `/${relativePath}`;

  let content = "";
  try {
    content = existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    return false;
  }
  if (content.split(/\r?\n/).some((line) => line.trim() === entry)) return false;

  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  try {
    writeFileSync(file, `${content}${separator}${entry}\n`, "utf8");
  } catch {
    return false;
  }
  return true;
}

function removeGitExclude(workspace: string, relativePath: string, added: boolean): void {
  if (!added) return;
  const file = join(workspace, ".git", "info", "exclude");
  const entry = `/${relativePath}`;
  try {
    const content = readFileSync(file, "utf8");
    const next = content
      .split(/\r?\n/)
      .filter((line) => line.trim() !== entry)
      .join("\n");
    writeFileSync(file, next, "utf8");
  } catch {
    // best effort
  }
}

export interface ConfigureSubagentModelOptions {
  workspace: string;
  models: SubagentModelInput;
  /** Lists the models the CLI reports as available; `null` means it could not list them. */
  listModels: () => Promise<string[] | null>;
  /** Receives a clear message when a configured model cannot be used. */
  warn?: (message: string) => void;
}

/**
 * Resolves the configured subagent model and, when it is actually available,
 * writes the agent file that pins it. Unavailable models are a warning, never a
 * failure: the run falls back to subagents inheriting the session model.
 */
export async function configureSubagentModel(
  options: ConfigureSubagentModelOptions,
): Promise<SubagentModelSetup> {
  const noop = (): void => {};
  const warn = options.warn ?? ((): void => {});

  const requested =
    (options.models.input ?? "").trim() || (options.models.repository ?? "").trim();
  if (requested.length === 0 || requested.toLowerCase() === "inherit") {
    return { cleanup: noop };
  }

  let available: string[] | null;
  try {
    available = await options.listModels();
  } catch {
    available = null;
  }

  if (!available) {
    const warning = `Could not list the models available to this account; subagents inherit the session model instead of using "${requested}".`;
    warn(warning);
    return { warning, cleanup: noop };
  }

  // Use the id as the CLI listed it: a short name accepted on the command line
  // is not necessarily a valid agent-file `model` value, so pin the canonical id.
  const model = resolveAvailableModel(requested, available);
  if (!model) {
    const warning = `Subagent model "${requested}" is not available to this account; subagents inherit the session model instead. Set "subagent-model" to a model the account can use to pin one.`;
    warn(warning);
    return { warning, cleanup: noop };
  }

  const filePath = join(options.workspace, SUBAGENT_AGENT_PATH);
  if (existsSync(filePath)) {
    const warning = `An agent file already exists at ${SUBAGENT_AGENT_PATH}; leaving it untouched instead of overwriting it.`;
    warn(warning);
    return { warning, cleanup: noop };
  }

  const excluded = addGitExclude(options.workspace, SUBAGENT_AGENT_PATH);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, agentFileContents(model), "utf8");
  } catch (error) {
    removeGitExclude(options.workspace, SUBAGENT_AGENT_PATH, excluded);
    const warning = `Could not write the subagent agent file (${error instanceof Error ? error.message : String(error)}); subagents inherit the session model instead.`;
    warn(warning);
    return { warning, cleanup: noop };
  }

  const cleanup = (): void => {
    try {
      rmSync(filePath, { force: true });
    } catch {
      // best effort
    }
    removeGitExclude(options.workspace, SUBAGENT_AGENT_PATH, excluded);
  };

  return { model, filePath, cleanup };
}
