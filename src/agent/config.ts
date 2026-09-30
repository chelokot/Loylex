import { readFileSync } from "node:fs";

export type AgentConfig = {
  bridgeUrl: string;
  bridgeToken: string;
  codexBinary: string;
  codexHome: string;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
  repositoryPath: string;
  memoryPath: string;
  pollIntervalMs: number;
  maxConcurrentJobs: number;
};

const defaultModel = "gpt-6.1-sol";
const defaultReasoningEffort = "low";
const legacyLunaModels = new Set(["gpt-5.6-luna", "gpt-6-luna"]);

export function resolveModel(configuredModel: string | undefined): string {
  // Existing host-managed Compose files can lag the repository image. Migrate
  // the previous Luna defaults while preserving other explicit model choices.
  return !configuredModel || legacyLunaModels.has(configuredModel) ? defaultModel : configuredModel;
}

export function resolveReasoningEffort(
  configuredEffort: string | undefined,
  configuredModel: string | undefined,
): string {
  if (configuredEffort === undefined) {
    return defaultReasoningEffort;
  }
  // Existing host Compose sets max with the old Luna default. The new target
  // accepts low and this migration preserves custom effort settings.
  if (configuredEffort === "max" && configuredModel && legacyLunaModels.has(configuredModel)) {
    return defaultReasoningEffort;
  }
  return configuredEffort;
}

function secret(): string {
  const path = process.env.LOYLEX_BRIDGE_TOKEN_FILE;
  const value = path ? readFileSync(path, "utf8").trim() : process.env.LOYLEX_BRIDGE_TOKEN;
  if (!value) {
    throw new Error("LOYLEX_BRIDGE_TOKEN_FILE or LOYLEX_BRIDGE_TOKEN is required");
  }
  return value;
}

export function loadAgentConfig(): AgentConfig {
  return {
    bridgeUrl: process.env.LOYLEX_BRIDGE_URL ?? "http://loylex-gateway:8787",
    bridgeToken: secret(),
    codexBinary: process.env.CODEX_BINARY ?? "codex",
    codexHome: process.env.CODEX_HOME ?? "/home/loylex/.codex",
    model: resolveModel(process.env.CODEX_MODEL),
    reasoningEffort: resolveReasoningEffort(
      process.env.CODEX_REASONING_EFFORT,
      process.env.CODEX_MODEL,
    ),
    serviceTier: process.env.CODEX_SERVICE_TIER ?? "priority",
    repositoryPath: process.env.LOYLEX_REPOSITORY_PATH ?? "/workspace/Loylex",
    memoryPath: process.env.LOYLEX_MEMORY_PATH ?? "/memory",
    pollIntervalMs: Number.parseInt(process.env.LOYLEX_POLL_INTERVAL_MS ?? "1000", 10),
    maxConcurrentJobs: Number.parseInt(process.env.LOYLEX_MAX_CONCURRENT_JOBS ?? "50", 10),
  };
}
