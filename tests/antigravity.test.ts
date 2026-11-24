import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentCancelledError, AgentLimitError, type AgentRun } from "../src/agent/agent-run.ts";
import { isAntigravityLimitMessage, runAntigravity } from "../src/agent/antigravity.ts";
import type { AgentConfig } from "../src/agent/config.ts";
import type { AgentEvent } from "../src/shared/types.ts";
import type { AgentTokenUsage } from "../src/shared/usage.ts";
import { testAgentConfig } from "./fixtures/agent-config.ts";

async function withConfig(
  overrides: Partial<AgentConfig>,
  fn: (config: AgentConfig) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "loylex-antigravity-test-"));
  try {
    await fn(
      testAgentConfig(home, {
        provider: "antigravity",
        antigravityBinary: resolve("tests/fixtures/antigravity.py"),
        antigravityModel: "gemini-4-neon-medium",
        ...overrides,
      }),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function run(overrides: Partial<AgentRun>): AgentRun {
  return {
    instructions: "standing instructions",
    prompt: "hello",
    resumeThreadId: null,
    signal: new AbortController().signal,
    onEvent: async () => {},
    onUsage: async () => {},
    onReady: () => {},
    ...overrides,
  };
}

test("streams commands, deduped tools, per-step usage, and live steering", async () => {
  await withConfig({}, async (config) => {
    const events: AgentEvent[] = [];
    const usageUpdates: AgentTokenUsage[] = [];
    const result = await runAntigravity(
      config,
      run({
        prompt: "steer me",
        onEvent: async (event) => {
          events.push(event);
        },
        onUsage: async (usage) => {
          usageUpdates.push(usage);
        },
        onReady: (control) => {
          if (control) void control.send("steered final answer", "telegram-42");
        },
      }),
    );

    expect(result.threadId).toBe("agy-conv-new-1");
    expect(result.answer).toBe("steered final answer");
    // Per-step usage (10+20 input, 4+6 cached, 5+8 output, 2+1 thinking) overrides cumulative result usage.
    expect(result.usage).toEqual({
      inputTokens: 30,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 0,
      outputTokens: 13,
      reasoningOutputTokens: 3,
      totalTokens: 43,
    });
    expect(usageUpdates.at(-1)).toEqual(result.usage);
    expect(events.filter((e) => e.kind === "command")).toHaveLength(1);
    expect(events.find((e) => e.kind === "command")?.text).toContain("echo hello-agy");
    expect(events.filter((e) => e.kind === "tool")).toHaveLength(1);
    expect(events.find((e) => e.kind === "tool")?.text).toContain("Loylex antigravity");
  });
});

test("forwards proxy, effort, model, and omits instructions on resumed conversation", async () => {
  await withConfig(
    {
      antigravityProxy: "http://127.0.0.1:3128",
      antigravityEffort: "high",
      antigravityModel: "gemini-4-neon-high",
    },
    async (config) => {
      const fresh = await runAntigravity(config, run({ prompt: "environment" }));
      expect(JSON.parse(fresh.answer)).toEqual({
        proxy: "http://127.0.0.1:3128",
        effort: "high",
        model: "gemini-4-neon-high",
        conversation: null,
        has_instructions: true,
      });

      const resumed = await runAntigravity(
        config,
        run({ prompt: "environment", resumeThreadId: "agy-conv-existing" }),
      );
      expect(resumed.threadId).toBe("agy-conv-existing");
      expect(JSON.parse(resumed.answer)).toEqual({
        proxy: "http://127.0.0.1:3128",
        effort: "high",
        model: "gemini-4-neon-high",
        conversation: "agy-conv-existing",
        has_instructions: false,
      });
    },
  );
});

test("terminates active Antigravity subprocess on cancellation", async () => {
  await withConfig({}, async (config) => {
    const controller = new AbortController();
    await expect(
      runAntigravity(
        config,
        run({
          prompt: "cancel me",
          signal: controller.signal,
          onEvent: async (event) => {
            if (event.kind === "command") controller.abort();
          },
        }),
      ),
    ).rejects.toBeInstanceOf(AgentCancelledError);
    expect(await Bun.file(join(config.repositoryPath, "agy-terminated")).exists()).toBe(true);
  });
});

test("classifies Antigravity rate/quota errors as AgentLimitError and leaves others plain", async () => {
  await withConfig({}, async (config) => {
    const limitErr = await runAntigravity(config, run({ prompt: "limit fail" })).catch(
      (err: unknown) => err,
    );
    expect(limitErr).toBeInstanceOf(AgentLimitError);
    expect((limitErr as AgentLimitError).provider).toBe("antigravity");

    const plainErr = await runAntigravity(config, run({ prompt: "plain fail" })).catch(
      (err: unknown) => err,
    );
    expect(plainErr).toBeInstanceOf(Error);
    expect(plainErr).not.toBeInstanceOf(AgentLimitError);
    expect((plainErr as Error).message).toBe("invalid argument: bad schema");
  });

  expect(isAntigravityLimitMessage("429 RESOURCE_EXHAUSTED")).toBe(true);
  expect(isAntigravityLimitMessage("Quota exceeded for model")).toBe(true);
  expect(isAntigravityLimitMessage("You've hit your usage limit")).toBe(true);
  expect(isAntigravityLimitMessage("invalid argument")).toBe(false);
  expect(isAntigravityLimitMessage("authentication required")).toBe(false);
});
