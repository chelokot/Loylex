export type AgentTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isAgentTokenUsage(value: unknown): value is AgentTokenUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const usage = value as Record<string, unknown>;
  return (
    nonNegativeInteger(usage.inputTokens) &&
    nonNegativeInteger(usage.cachedInputTokens) &&
    nonNegativeInteger(usage.cacheWriteInputTokens) &&
    nonNegativeInteger(usage.outputTokens) &&
    nonNegativeInteger(usage.reasoningOutputTokens) &&
    nonNegativeInteger(usage.totalTokens)
  );
}
