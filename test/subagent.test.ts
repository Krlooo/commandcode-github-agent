import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAvailableModels } from "../src/agent";
import {
  configureSubagentModel,
  isModelAvailable,
  readRepositoryModel,
  resolveAvailableModel,
  REPOSITORY_MODEL_FILE,
  SUBAGENT_AGENT_PATH,
} from "../src/subagent";

const workspaces: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "cmdc-subagent-"));
  workspaces.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseAvailableModels", () => {
  const output = [
    "Available models  ·  3 models",
    "",
    "Open Source",
    "",
    "deepseek/deepseek-v4-flash             fast hybrid-attention reasoning (default)",
    "moonshotai/kimi-k2.5                   multimodal frontend coding",
    "",
    "Anthropic",
    "",
    "claude-sonnet-5                        best combo of speed & intelligence (recommended)",
    "",
    'Pass the full id, or just the short name after the last "/":',
    "cmd --model moonshotai/kimi-k2.5",
    "cmd --model kimi-k2.5",
    "",
    "Decision models (headless only)",
    "typesafe/jev  typed questions in, probabilities out",
  ].join("\n");

  it("extracts the model ids and skips headings and the usage footer", () => {
    expect(parseAvailableModels(output)).toEqual([
      "deepseek/deepseek-v4-flash",
      "moonshotai/kimi-k2.5",
      "claude-sonnet-5",
    ]);
  });

  it("returns an empty list for unrelated text", () => {
    expect(parseAvailableModels("no models here")).toEqual([]);
  });
});

describe("isModelAvailable", () => {
  const available = ["deepseek/deepseek-v4-flash", "claude-sonnet-5"];

  it("matches a full id, case-insensitively", () => {
    expect(isModelAvailable("deepseek/deepseek-v4-flash", available)).toBe(true);
    expect(isModelAvailable("Claude-Sonnet-5", available)).toBe(true);
  });

  it("matches the short name after the last slash", () => {
    expect(isModelAvailable("claude-sonnet-5", available)).toBe(true);
  });

  it("rejects unknown and empty ids", () => {
    expect(isModelAvailable("gpt-6-astra", available)).toBe(false);
    expect(isModelAvailable("  ", available)).toBe(false);
  });
});

describe("resolveAvailableModel", () => {
  const available = ["deepseek/deepseek-v4-flash", "moonshotai/kimi-k2.5", "claude-sonnet-5"];

  it("returns the listed id for a short name so the agent file gets a canonical id", () => {
    expect(resolveAvailableModel("kimi-k2.5", available)).toBe("moonshotai/kimi-k2.5");
    expect(resolveAvailableModel("deepseek-v4-flash", available)).toBe("deepseek/deepseek-v4-flash");
  });

  it("returns the listed id for a full id, case-insensitively", () => {
    expect(resolveAvailableModel("moonshotai/kimi-k2.5", available)).toBe("moonshotai/kimi-k2.5");
    expect(resolveAvailableModel("Claude-Sonnet-5", available)).toBe("claude-sonnet-5");
  });

  it("returns undefined for unknown and empty ids", () => {
    expect(resolveAvailableModel("gpt-6-astra", available)).toBeUndefined();
    expect(resolveAvailableModel("  ", available)).toBeUndefined();
  });
});

describe("readRepositoryModel", () => {
  it("reads the first non-empty, non-comment line", () => {
    const dir = workspace();
    mkdirSync(join(dir, ".commandcode"), { recursive: true });
    writeFileSync(join(dir, REPOSITORY_MODEL_FILE), "# the repo default\n\nclaude-sonnet-5\n", "utf8");
    expect(readRepositoryModel(dir)).toBe("claude-sonnet-5");
  });

  it("returns undefined when the file is missing, empty or inherit", () => {
    const dir = workspace();
    expect(readRepositoryModel(dir)).toBeUndefined();
    mkdirSync(join(dir, ".commandcode"), { recursive: true });
    writeFileSync(join(dir, REPOSITORY_MODEL_FILE), "\n", "utf8");
    expect(readRepositoryModel(dir)).toBeUndefined();
    writeFileSync(join(dir, REPOSITORY_MODEL_FILE), "inherit\n", "utf8");
    expect(readRepositoryModel(dir)).toBeUndefined();
  });
});

describe("configureSubagentModel", () => {
  const available = ["deepseek/deepseek-v4-flash", "claude-sonnet-5"];

  it("writes the agent file when the configured model is available", async () => {
    const dir = workspace();
    const setup = await configureSubagentModel({
      workspace: dir,
      models: { input: "claude-sonnet-5" },
      listModels: async () => available,
    });

    expect(setup.model).toBe("claude-sonnet-5");
    const file = join(dir, SUBAGENT_AGENT_PATH);
    expect(existsSync(file)).toBe(true);
    const contents = readFileSync(file, "utf8");
    expect(contents).toContain("name: commandcode-subagent");
    expect(contents).toContain("model: claude-sonnet-5");
    expect(contents.startsWith("---")).toBe(true);

    setup.cleanup();
    expect(existsSync(file)).toBe(false);
  });

  it("resolves a short name to the id the CLI listed before writing the file", async () => {
    const dir = workspace();
    const listed = ["moonshotai/kimi-k2.5", "claude-sonnet-5"];
    const setup = await configureSubagentModel({
      workspace: dir,
      models: { input: "kimi-k2.5" },
      listModels: async () => listed,
    });

    expect(setup.model).toBe("moonshotai/kimi-k2.5");
    expect(readFileSync(join(dir, SUBAGENT_AGENT_PATH), "utf8")).toContain(
      "model: moonshotai/kimi-k2.5",
    );
    setup.cleanup();
  });

  it("falls back with a warning when the model is not available", async () => {
    const dir = workspace();
    const warn = vi.fn();
    const setup = await configureSubagentModel({
      workspace: dir,
      models: { input: "gpt-6-astra" },
      listModels: async () => available,
      warn,
    });

    expect(setup.model).toBeUndefined();
    expect(setup.warning).toMatch(/not available/i);
    expect(warn).toHaveBeenCalledWith(setup.warning);
    expect(existsSync(join(dir, SUBAGENT_AGENT_PATH))).toBe(false);
  });

  it("writes nothing when no model is configured", async () => {
    const dir = workspace();
    const listModels = vi.fn(async () => available);
    const setup = await configureSubagentModel({ workspace: dir, models: {}, listModels });

    expect(setup.model).toBeUndefined();
    expect(setup.warning).toBeUndefined();
    expect(listModels).not.toHaveBeenCalled();
    expect(existsSync(join(dir, SUBAGENT_AGENT_PATH))).toBe(false);
    setup.cleanup();
  });

  it("writes nothing for inherit", async () => {
    const dir = workspace();
    const setup = await configureSubagentModel({
      workspace: dir,
      models: { input: "inherit" },
      listModels: async () => available,
    });

    expect(setup.model).toBeUndefined();
    expect(setup.warning).toBeUndefined();
    expect(existsSync(join(dir, SUBAGENT_AGENT_PATH))).toBe(false);
  });

  it("uses the repository default when the input is empty", async () => {
    const dir = workspace();
    const setup = await configureSubagentModel({
      workspace: dir,
      models: { repository: "deepseek/deepseek-v4-flash" },
      listModels: async () => available,
    });

    expect(setup.model).toBe("deepseek/deepseek-v4-flash");
    expect(existsSync(join(dir, SUBAGENT_AGENT_PATH))).toBe(true);
    setup.cleanup();
  });

  it("lets the input override the repository default", async () => {
    const dir = workspace();
    const setup = await configureSubagentModel({
      workspace: dir,
      models: { input: "claude-sonnet-5", repository: "deepseek/deepseek-v4-flash" },
      listModels: async () => available,
    });

    expect(setup.model).toBe("claude-sonnet-5");
    expect(readFileSync(join(dir, SUBAGENT_AGENT_PATH), "utf8")).toContain("model: claude-sonnet-5");
    setup.cleanup();
  });

  it("warns and falls back when the model list cannot be produced", async () => {
    const dir = workspace();
    const setup = await configureSubagentModel({
      workspace: dir,
      models: { input: "claude-sonnet-5" },
      listModels: async () => null,
    });

    expect(setup.model).toBeUndefined();
    expect(setup.warning).toMatch(/could not list/i);
    expect(existsSync(join(dir, SUBAGENT_AGENT_PATH))).toBe(false);
  });

  it("hides the generated file from git and cleans the exclusion up", async () => {
    const dir = workspace();
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    writeFileSync(join(dir, ".git", "info", "exclude"), "# existing\n", "utf8");

    const setup = await configureSubagentModel({
      workspace: dir,
      models: { input: "claude-sonnet-5" },
      listModels: async () => available,
    });

    const exclude = join(dir, ".git", "info", "exclude");
    expect(readFileSync(exclude, "utf8")).toContain(`/${SUBAGENT_AGENT_PATH}`);

    setup.cleanup();
    expect(readFileSync(exclude, "utf8")).not.toContain(SUBAGENT_AGENT_PATH);
    expect(existsSync(join(dir, SUBAGENT_AGENT_PATH))).toBe(false);
  });
});
