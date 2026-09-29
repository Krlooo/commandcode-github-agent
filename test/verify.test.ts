import { describe, expect, it } from "vitest";
import { runVerification, verificationEnv } from "../src/verify";

describe("verificationEnv", () => {
  it("keeps the infrastructure variables the command needs", () => {
    const env = verificationEnv({ PATH: "/usr/bin", HOME: "/home/runner", LANG: "C.UTF-8" });
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/runner");
    expect(env["LANG"]).toBe("C.UTF-8");
  });

  it("drops GitHub, Actions, action-input and provider credentials", () => {
    const env = verificationEnv({
      PATH: "/usr/bin",
      GITHUB_TOKEN: "ghs_write",
      GH_TOKEN: "ghp_read",
      ACTIONS_RUNTIME_TOKEN: "runtime",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc",
      INPUT_COMMAND_CODE_API_KEY: "key",
      COMMAND_CODE_API_KEY: "key",
      INPUT_PROVIDER_API_KEY: "provider",
      CMD_AGENT_PROVIDER_KEY: "provider",
      INPUT_AGENT_TOKEN: "read",
    });

    expect(env["PATH"]).toBe("/usr/bin");
    for (const key of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "ACTIONS_RUNTIME_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "INPUT_COMMAND_CODE_API_KEY",
      "COMMAND_CODE_API_KEY",
      "INPUT_PROVIDER_API_KEY",
      "CMD_AGENT_PROVIDER_KEY",
      "INPUT_AGENT_TOKEN",
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });
});

describe.runIf(process.platform !== "win32")("runVerification", () => {
  const source = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "/tmp",
  };

  it("captures stdout and a zero exit code on success", async () => {
    const result = await runVerification(process.cwd(), "echo hello", source);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello");
  });

  it("captures a non-zero exit code instead of throwing", async () => {
    const result = await runVerification(process.cwd(), "exit 3", source);
    expect(result.exitCode).toBe(3);
  });

  it("does not expose inherited secrets to the command it runs", async () => {
    const result = await runVerification(
      process.cwd(),
      'node -p "process.env.GITHUB_TOKEN || \'unset\'"',
      { ...source, GITHUB_TOKEN: "ghs_secret", COMMAND_CODE_API_KEY: "key" },
    );
    expect(result.output).toContain("unset");
    expect(result.output).not.toContain("ghs_secret");
    expect(result.output).not.toContain("key");
  });
});
