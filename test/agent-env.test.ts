import { describe, expect, it } from "vitest";
import { agentEnv } from "../src/agent";

describe("agentEnv", () => {
  it("keeps infrastructure variables needed to run node, npm and git", () => {
    const env = agentEnv(
      { PATH: "/usr/local/bin:/usr/bin", HOME: "/home/runner", LANG: "C.UTF-8", TMPDIR: "/tmp" },
      {},
    );
    expect(env["PATH"]).toBe("/usr/local/bin:/usr/bin");
    expect(env["HOME"]).toBe("/home/runner");
    expect(env["LANG"]).toBe("C.UTF-8");
  });

  it("drops GitHub, Actions and action-input secrets", () => {
    const env = agentEnv(
      {
        PATH: "/usr/bin",
        GITHUB_TOKEN: "ghs_installation_token",
        GH_TOKEN: "ghp_x",
        ACTIONS_RUNTIME_TOKEN: "runtime",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc",
        INPUT_COMMAND_CODE_API_KEY: "key",
        INPUT_PROVIDER_API_KEY: "key2",
        INPUT_MENTIONS: "/cmd",
        RUNNER_TEMP: "/tmp/runner",
        SOMETHING_RANDOM: "x",
      },
      {},
    );
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["GH_TOKEN"]).toBeUndefined();
    expect(env["ACTIONS_RUNTIME_TOKEN"]).toBeUndefined();
    expect(env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]).toBeUndefined();
    expect(env["INPUT_COMMAND_CODE_API_KEY"]).toBeUndefined();
    expect(env["INPUT_PROVIDER_API_KEY"]).toBeUndefined();
    expect(env["RUNNER_TEMP"]).toBeUndefined();
    expect(env["SOMETHING_RANDOM"]).toBeUndefined();
  });

  it("applies the model credentials as overrides", () => {
    const env = agentEnv(
      { PATH: "/usr/bin", COMMAND_CODE_API_KEY: "stale" },
      { COMMAND_CODE_API_KEY: "fresh", CMD_LOCAL_ONLY: "1" },
    );
    expect(env["COMMAND_CODE_API_KEY"]).toBe("fresh");
    expect(env["CMD_LOCAL_ONLY"]).toBe("1");
  });
});
