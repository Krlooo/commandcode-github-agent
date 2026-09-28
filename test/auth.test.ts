import { describe, expect, it } from "vitest";
import { setupAgentAuth } from "../src/auth";

describe("setupAgentAuth", () => {
  it("returns COMMAND_CODE_API_KEY as the env override when a Command Code API key is given", async () => {
    const result = await setupAgentAuth({ commandCodeApiKey: "user_test_key" }, {});
    expect(result.envOverrides).toEqual({ COMMAND_CODE_API_KEY: "user_test_key" });
  });

  it("prefers the Command Code API key over BYOK provider inputs", async () => {
    const result = await setupAgentAuth(
      {
        commandCodeApiKey: "user_test_key",
        provider: "openrouter",
        providerApiKey: "sk-or-test",
        model: "some/model",
      },
      {},
    );
    expect(result.envOverrides).toEqual({ COMMAND_CODE_API_KEY: "user_test_key" });
  });

  it("returns no overrides when no key is configured", async () => {
    const result = await setupAgentAuth({}, {});
    expect(result.envOverrides).toEqual({});
  });

  it("still requires a model when a BYOK provider API key is given", async () => {
    await expect(
      setupAgentAuth({ providerApiKey: "sk-or-test" }, {}),
    ).rejects.toThrow(/model input is required/);
  });
});
