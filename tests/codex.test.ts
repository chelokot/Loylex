import { expect, test } from "bun:test";
import { parseCodexUsage } from "../src/agent/codex.ts";

test("parses the usage payload from a completed Codex turn", () => {
  expect(
    parseCodexUsage({
      type: "turn.completed",
      usage: {
        input_tokens: 120,
        cached_input_tokens: 80,
        cache_write_input_tokens: 4,
        output_tokens: 30,
        reasoning_output_tokens: 20,
        total_tokens: 150,
      },
    }),
  ).toEqual({
    inputTokens: 120,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 4,
    outputTokens: 30,
    reasoningOutputTokens: 20,
    totalTokens: 150,
  });
});

test("fills missing optional Codex usage counters from zero", () => {
  expect(parseCodexUsage({ usage: { input_tokens: 12, output_tokens: 3 } })).toEqual({
    inputTokens: 12,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 3,
    reasoningOutputTokens: 0,
    totalTokens: 15,
  });
});

test("ignores malformed or unrelated Codex events", () => {
  expect(parseCodexUsage({ type: "item.completed", item: { type: "agent_message" } })).toBeNull();
  expect(parseCodexUsage({ type: "turn.completed", usage: { input_tokens: -1 } })).toBeNull();
});
