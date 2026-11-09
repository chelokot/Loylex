import { readFileSync } from "node:fs";
import type { AgentProvider } from "./agent-run.ts";

export type AgentConfig = {
  provider: AgentProvider;
  claudeChatIds: ReadonlySet<number>;
  bridgeUrl: string;
  bridgeToken: string;
  codexBinary: string;
  codexHome: string;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
  claudeBinary: string;
  claudeModel: string;
  claudeEffort: string;
  claudeOauthTokenFile: string;
  claudeProxy: string | null;
  repositoryPath: string;
  memoryPath: string;
  statePath: string;
  pollIntervalMs: number;
  maxConcurrentJobs: number;
};

function secret(): string {
  const path = process.env.LOYLEX_BRIDGE_TOKEN_FILE;
  const value = path ? readFileSync(path, "utf8").trim() : process.env.LOYLEX_BRIDGE_TOKEN;
  if (!value) {
    throw new Error("LOYLEX_BRIDGE_TOKEN_FILE or LOYLEX_BRIDGE_TOKEN is required");
  }
  return value;
}

function provider(): AgentProvider {
  const value = process.env.LOYLEX_AGENT_PROVIDER ?? "codex";
  if (value !== "codex" && value !== "claude") {
    throw new Error("LOYLEX_AGENT_PROVIDER must be codex or claude");
  }
  return value;
}

function chatIds(value: string): ReadonlySet<number> {
  const ids = value
    .split(",")
    .filter(Boolean)
    .map((id) => Number(id.trim()));
  if (!ids.every(Number.isSafeInteger)) {
    throw new Error("LOYLEX_CLAUDE_CHAT_IDS must list integer Telegram chat IDs");
  }
  return new Set(ids);
}

export function loadAgentConfig(): AgentConfig {
  return {
    provider: provider(),
    claudeChatIds: chatIds(process.env.LOYLEX_CLAUDE_CHAT_IDS ?? ""),
    bridgeUrl: process.env.LOYLEX_BRIDGE_URL ?? "http://loylex-gateway:8787",
    bridgeToken: secret(),
    codexBinary: process.env.CODEX_BINARY ?? "codex",
    codexHome: process.env.CODEX_HOME ?? "/home/loylex/.codex",
    model: process.env.CODEX_MODEL ?? "gpt-6.1-sol",
    reasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "low",
    // Disable Fast, including priority retained by older host Compose environments.
    serviceTier: "default",
    claudeBinary: process.env.CLAUDE_BINARY ?? "claude",
    claudeModel: process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
    claudeEffort: process.env.CLAUDE_EFFORT ?? "medium",
    claudeOauthTokenFile:
      process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE ?? "/run/secrets/loylex-claude-oauth-token",
    claudeProxy: process.env.CLAUDE_HTTPS_PROXY ?? null,
    repositoryPath: process.env.LOYLEX_REPOSITORY_PATH ?? "/workspace/Loylex",
    memoryPath: process.env.LOYLEX_MEMORY_PATH ?? "/memory",
    statePath: process.env.LOYLEX_STATE_PATH ?? "/home/loylex/.local/state/loylex",
    pollIntervalMs: Number.parseInt(process.env.LOYLEX_POLL_INTERVAL_MS ?? "1000", 10),
    maxConcurrentJobs: Number.parseInt(process.env.LOYLEX_MAX_CONCURRENT_JOBS ?? "50", 10),
  };
}
