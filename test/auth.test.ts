import { describe, expect, it } from "vitest";
import { mergeProvidersConfig, setupAgentAuth } from "../src/auth";

describe("mergeProvidersConfig", () => {
  const entry = {
    name: "agent",
    baseURL: "https://api.commandcode.ai/provider/v1",
    apiKey: "$CMD_AGENT_PROVIDER_KEY",
    models: { "some/model": {} },
  };

  it("creates the provider envelope from an empty root", () => {
    expect(mergeProvidersConfig({}, "agent", entry)).toEqual({ provider: { agent: entry } });
  });

  it("treats a non-record root as empty", () => {
    expect(mergeProvidersConfig(null, "agent", entry)).toEqual({ provider: { agent: entry } });
    expect(mergeProvidersConfig("nope", "agent", entry)).toEqual({ provider: { agent: entry } });
  });

  it("preserves other providers under the provider map", () => {
    const merged = mergeProvidersConfig({ provider: { other: { x: 1 } } }, "agent", entry);
    expect(merged).toEqual({ provider: { other: { x: 1 }, agent: entry } });
  });

  it("preserves unrelated root keys", () => {
    const merged = mergeProvidersConfig(
      { theme: "dark", provider: { other: { x: 1 } } },
      "agent",
      entry,
    );
    expect(merged).toEqual({ theme: "dark", provider: { other: { x: 1 }, agent: entry } });
  });

  it("folds a legacy providers key into the provider map and drops it", () => {
    const merged = mergeProvidersConfig({ providers: { legacy: { y: 2 } } }, "agent", entry);
    expect(merged).toEqual({ provider: { legacy: { y: 2 }, agent: entry } });
    expect(merged).not.toHaveProperty("providers");
  });

  it("lets the provider map win over legacy providers on conflicts", () => {
    const merged = mergeProvidersConfig(
      { provider: { shared: { from: "provider" } }, providers: { shared: { from: "legacy" } } },
      "agent",
      entry,
    );
    expect(merged["provider"]).toEqual({ shared: { from: "provider" }, agent: entry });
  });

  it("does not mutate the existing config", () => {
    const existing = { provider: { other: { x: 1 } }, providers: { legacy: { y: 2 } } };
    mergeProvidersConfig(existing, "agent", entry);
    expect(existing).toEqual({ provider: { other: { x: 1 } }, providers: { legacy: { y: 2 } } });
  });
});

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
