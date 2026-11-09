import type { AgentConfig } from "../../src/agent/config.ts";

export function testAgentConfig(home: string, overrides: Partial<AgentConfig>): AgentConfig {
  return {
    provider: "codex",
    claudeChatIds: new Set(),
    bridgeUrl: "",
    bridgeToken: "",
    codexBinary: "codex",
    codexHome: home,
    model: "test-model",
    reasoningEffort: "low",
    serviceTier: "priority",
    claudeBinary: "claude",
    claudeModel: "test-claude-model",
    claudeEffort: "medium",
    claudeOauthTokenFile: `${home}/claude-oauth-token`,
    claudeProxy: null,
    repositoryPath: home,
    memoryPath: home,
    statePath: home,
    pollIntervalMs: 1000,
    maxConcurrentJobs: 1,
    ...overrides,
  };
}
