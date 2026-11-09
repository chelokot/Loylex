import type { AgentTokenUsage } from "../shared/usage.ts";
import { AgentCancelledError } from "./agent-run.ts";

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name} ${error.message}` : String(error);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usageFromRecord(value: unknown): AgentTokenUsage | null {
  const usage = record(value);
  if (!usage) {
    return null;
  }
  const inputTokens = nonNegativeInteger(usage.input_tokens);
  const cachedInputTokens = nonNegativeInteger(usage.cached_input_tokens);
  const cacheWriteInputTokens = nonNegativeInteger(usage.cache_write_input_tokens);
  const outputTokens = nonNegativeInteger(usage.output_tokens);
  const reasoningOutputTokens = nonNegativeInteger(usage.reasoning_output_tokens);
  const totalTokens = nonNegativeInteger(usage.total_tokens);
  if (inputTokens === null && outputTokens === null) {
    return null;
  }
  const normalizedInputTokens = inputTokens ?? 0;
  const normalizedOutputTokens = outputTokens ?? 0;
  const computedTotal = normalizedInputTokens + normalizedOutputTokens;
  return {
    inputTokens: normalizedInputTokens,
    cachedInputTokens: cachedInputTokens ?? 0,
    cacheWriteInputTokens: cacheWriteInputTokens ?? 0,
    outputTokens: normalizedOutputTokens,
    reasoningOutputTokens: reasoningOutputTokens ?? 0,
    totalTokens: totalTokens ?? (Number.isSafeInteger(computedTotal) ? computedTotal : 0),
  };
}

export function parseCodexUsage(event: unknown): AgentTokenUsage | null {
  const value = record(event);
  if (!value) {
    return null;
  }
  for (const candidate of [value.usage, value.token_usage]) {
    const usage = usageFromRecord(candidate);
    if (usage) {
      return usage;
    }
  }
  return null;
}

export function isThreadStoreConflict(error: unknown): boolean {
  return /\bthread(?:-store conflict\b[\s\S]*\bactive writer\b|\s+\S+\s+already has an active writer\b)/i.test(
    errorText(error),
  );
}

export async function waitForThreadWriter(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    throw new AgentCancelledError();
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    function abort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new AgentCancelledError());
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
