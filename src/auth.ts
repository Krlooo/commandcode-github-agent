/**
 * Agent authentication: writes the Command Code BYOK provider config
 * (`~/.commandcode/providers.json`) and returns the env overrides the CLI needs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PROVIDER_ID = "agent";
const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1";

export interface AgentAuthInputs {
  provider?: string;
  providerBaseUrl?: string;
  providerApiKey?: string;
  model?: string;
}

export interface AgentAuthResult {
  envOverrides: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Configures Command Code provider auth from action inputs.
 *
 * When an API key input is present, merges a provider entry into
 * `~/.commandcode/providers.json` and returns `{ CMD_LOCAL_ONLY, CMD_AGENT_PROVIDER_KEY }`.
 * When it is absent, the file is left untouched and `{}` is returned.
 */
export async function setupAgentAuth(
  inputs: AgentAuthInputs,
  env: Record<string, string | undefined>,
): Promise<AgentAuthResult> {
  const apiKey = inputs.providerApiKey?.trim();
  if (!apiKey) return { envOverrides: {} };

  const providerId = inputs.provider?.trim() || DEFAULT_PROVIDER_ID;
  const modelId = inputs.model?.trim();
  if (!modelId) {
    throw new Error(
      "A provider API key was provided but no model input was set; the model input is required to configure the provider.",
    );
  }

  const baseURL =
    inputs.providerBaseUrl?.trim() || env["CMD_AGENT_PROVIDER_BASE_URL"]?.trim() || DEFAULT_BASE_URL;

  const directory = join(homedir(), ".commandcode");
  const file = join(directory, "providers.json");

  let providers: Record<string, unknown> = {};
  if (existsSync(file)) {
    let parsed: unknown;
    let ok = false;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
      if (isRecord(parsed)) {
        providers = parsed;
        ok = true;
      }
    } catch {
      ok = false;
    }

    if (!ok) {
      console.warn(
        `Could not parse ${file}; overwriting it with a fresh provider configuration.`,
      );
      providers = {};
    }
  }

  providers[providerId] = {
    name: providerId,
    baseURL,
    apiKey: "$CMD_AGENT_PROVIDER_KEY",
    models: { [modelId]: {} },
  };

  mkdirSync(directory, { recursive: true });
  writeFileSync(file, `${JSON.stringify(providers, null, 2)}\n`, "utf8");

  return { envOverrides: { CMD_LOCAL_ONLY: "1", CMD_AGENT_PROVIDER_KEY: apiKey } };
}
