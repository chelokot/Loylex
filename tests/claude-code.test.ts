import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentCancelledError, type AgentRun } from "../src/agent/agent-run.ts";
import { runClaudeCode } from "../src/agent/claude-code.ts";
import type { AgentConfig } from "../src/agent/config.ts";
import type { AgentEvent } from "../src/shared/types.ts";
import type { AgentTokenUsage } from "../src/shared/usage.ts";
import { testAgentConfig } from "./fixtures/agent-config.ts";

async function withConfig(
  overrides: Partial<AgentConfig>,
  body: (config: AgentConfig) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "loylex-claude-test-"));
  try {
    await body(
      testAgentConfig(home, {
        claudeBinary: resolve("tests/fixtures/claude-code.py"),
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
    prompt: "original",
    resumeThreadId: null,
    signal: new AbortController().signal,
    onEvent: async () => {},
    onUsage: async () => {},
    onReady: () => {},
    ...overrides,
  };
}

test("steers the running turn and reports its work and usage on the resumed session", async () => {
  await withConfig({}, async (config) => {
    const events: AgentEvent[] = [];
    const usages: AgentTokenUsage[] = [];
    const result = await runClaudeCode(
      config,
      run({
        prompt: "steer me",
        resumeThreadId: "11111111-2222-3333-4444-555555555555",
        onEvent: async (event) => {
          events.push(event);
        },
        onUsage: async (usage) => {
          usages.push(usage);
        },
        onReady: (control) => {
          if (control) void control.send("steered answer", "telegram-1");
        },
      }),
    );
    const threadId = "11111111-2222-3333-4444-555555555555";
    expect(result).toEqual({
      answer: "steered answer",
      threadId,
      usage: {
        inputTokens: 35,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 5,
        outputTokens: 7,
        reasoningOutputTokens: 3,
        totalTokens: 42,
      },
    });
    expect(usages).toEqual([result.usage as AgentTokenUsage]);
    expect(events).toEqual([
      { kind: "status", text: "Начинаю работу", threadId },
      { kind: "commentary", text: "working", threadId },
      { kind: "command", text: "echo example", threadId },
      { kind: "status", text: "Команда завершена", threadId },
      { kind: "tool", text: "Searched for 'Loylex'", threadId, toolCallId: "search-1" },
    ]);
  });
});

test("answers input that arrives after the last tool call as a further turn of the same job", async () => {
  await withConfig({}, async (config) => {
    const result = await runClaudeCode(
      config,
      run({
        prompt: "queue me",
        onReady: (control) => {
          if (control) void control.send("late answer", "telegram-2");
        },
      }),
    );
    expect(result.answer).toBe("first answer\n\nlate answer");
    expect(result.usage?.totalTokens).toBe(84);
  });
});

test("starts a new session under an ID chosen before the model answers", async () => {
  await withConfig({ claudeProxy: "http://host.containers.internal:3128" }, async (config) => {
    const result = await runClaudeCode(config, run({ prompt: "environment" }));
    expect(JSON.parse(result.answer)).toEqual({
      proxy: "http://host.containers.internal:3128",
      session: result.threadId,
    });
    expect(result.threadId).toMatch(/^[0-9a-f-]{36}$/);
  });
  // The child inherits the container's HTTPS_PROXY, so unset it to test the unconfigured case.
  const inheritedProxy = process.env.HTTPS_PROXY;
  Reflect.deleteProperty(process.env, "HTTPS_PROXY");
  try {
    await withConfig({}, async (config) => {
      const result = await runClaudeCode(config, run({ prompt: "environment" }));
      expect(JSON.parse(result.answer).proxy).toBeNull();
    });
  } finally {
    if (inheritedProxy !== undefined) process.env.HTTPS_PROXY = inheritedProxy;
  }
});

test("interrupts the active turn when the job is cancelled", async () => {
  await withConfig({}, async (config) => {
    const controller = new AbortController();
    await expect(
      runClaudeCode(
        config,
        run({
          prompt: "interrupt me",
          signal: controller.signal,
          onEvent: async (event) => {
            if (event.kind === "command") controller.abort();
          },
        }),
      ),
    ).rejects.toBeInstanceOf(AgentCancelledError);
    expect(await Bun.file(join(config.repositoryPath, "interrupted")).exists()).toBe(true);
  });
});

test("fails closed on interactive requests and reports failed turns", async () => {
  await withConfig({}, async (config) => {
    expect((await runClaudeCode(config, run({ prompt: "ask me" }))).answer).toBe("denied: error");
    await expect(runClaudeCode(config, run({ prompt: "fail" }))).rejects.toThrow(
      "Claude Code turn failed: You've hit your limit",
    );
  });
});
