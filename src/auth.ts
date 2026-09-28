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
  commandCodeApiKey?: string;
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
 * Returns a NEW providers config with `entry` registered under `providerId`.
 *
 * The CLI reads providers from a singular `provider` map; a legacy plural
 * `providers` key is folded into it (the `provider` map wins on conflicts) and
 * dropped. Every unrelated root key and every other provider is preserved, and
 * the input object is never mutated.
 */
export function mergeProvidersConfig(
  existing: unknown,
  providerId: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const root: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};

  const provider = isRecord(root["provider"]) ? { ...root["provider"] } : {};
  const legacy = isRecord(root["providers"]) ? root["providers"] : undefined;

  const merged: Record<string, unknown> = { ...(legacy ?? {}), ...provider };
  merged[providerId] = entry;

  delete root["providers"];
  root["provider"] = merged;
  return root;
}

/**
 * Configures Command Code provider auth from action inputs.
 *
 * A Command Code API key is returned as `{ COMMAND_CODE_API_KEY }` (the documented
 * CI auth path: no login, no providers.json). A BYOK provider key merges a provider
 * entry into `~/.commandcode/providers.json` and returns
 * `{ CMD_LOCAL_ONLY, CMD_AGENT_PROVIDER_KEY }`. With neither, the file is left
 * untouched and `{}` is returned.
 */
export async function setupAgentAuth(
  inputs: AgentAuthInputs,
  env: Record<string, string | undefined>,
): Promise<AgentAuthResult> {
  const commandCodeKey = inputs.commandCodeApiKey?.trim();
  if (commandCodeKey) {
    return { envOverrides: { COMMAND_CODE_API_KEY: commandCodeKey } };
  }

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

  let existing: unknown;
  if (existsSync(file)) {
    let parsed: unknown;
    let ok = false;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
      ok = isRecord(parsed);
    } catch {
      ok = false;
    }

    if (ok) {
      existing = parsed;
    } else {
      console.warn(
        `Could not parse ${file}; overwriting it with a fresh provider configuration.`,
      );
    }
  }

  const entry = {
    name: providerId,
    baseURL,
    apiKey: "$CMD_AGENT_PROVIDER_KEY",
    models: { [modelId]: {} },
  };

  const providers = mergeProvidersConfig(existing, providerId, entry);

  mkdirSync(directory, { recursive: true });
  writeFileSync(file, `${JSON.stringify(providers, null, 2)}\n`, "utf8");

  return { envOverrides: { CMD_LOCAL_ONLY: "1", CMD_AGENT_PROVIDER_KEY: apiKey } };
}
