import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLimitError, type AgentProvider, type AgentRun } from "../src/agent/agent-run.ts";
import { agentInstructions } from "../src/agent/prompt.ts";
import {
  executeJobWithFallback,
  type FallbackNotice,
  ProviderLimitCooldown,
  type ProviderRunner,
} from "../src/agent/provider-runner.ts";
import { readThreadState, writeThreadState } from "../src/agent/thread-state.ts";
import type { AgentJob, AgentJobFallbackContext } from "../src/shared/types.ts";
import type { AgentTokenUsage } from "../src/shared/usage.ts";
import { testAgentConfig } from "./fixtures/agent-config.ts";

function makeJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 1,
    updateId: 100,
    chatId: 42,
    chatType: "private",
    messageId: 10,
    messageThreadId: null,
    userId: 7,
    prompt: "Привет, проверь статус",
    resumeThreadId: null,
    context: "recent chat line",
    contextMode: "full",
    replyToMessageId: null,
    replyContext: null,
    attachments: [],
    ...overrides,
  };
}

function usage(input: number, output: number): AgentTokenUsage {
  return {
    inputTokens: input,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: input + output,
  };
}

async function withWorkspace(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "loylex-antigravity-fallback-"));
  try {
    await mkdir(join(home, "buckets"), { recursive: true });
    await writeFile(
      join(home, "buckets", "index.json"),
      JSON.stringify({ buckets: [{ file: "profile.md", terms: ["статус"] }] }),
    );
    await writeFile(join(home, "buckets", "profile.md"), "Private note about status.");
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("falls back from Claude Code to Codex and then to Antigravity when both hit limits", async () => {
  await withWorkspace(async (home) => {
    const now = 50_000;
    const cooldown = new ProviderLimitCooldown({
      now: () => now,
      defaultCooldownMs: 60_000,
      maxCooldownMs: 300_000,
    });
    const calls: AgentProvider[] = [];
    const fallbacks: FallbackNotice[] = [];

    const runners: Record<AgentProvider, ProviderRunner> = {
      claude: async (_config, run) => {
        calls.push("claude");
        await run.onUsage(usage(100, 0), "claude-tmp");
        throw new AgentLimitError("claude", "Claude Code turn failed: weekly limit", now + 200_000);
      },
      codex: async (_config, run) => {
        calls.push("codex");
        await run.onUsage(usage(50, 0), "codex-tmp");
        throw new AgentLimitError("codex", "You’ve hit your usage limit", now + 100_000);
      },
      antigravity: async (_config, run) => {
        calls.push("antigravity");
        await run.onEvent({ kind: "status", text: "Начинаю работу", threadId: "agy-1" });
        await run.onUsage(usage(80, 20), "agy-1");
        return { answer: "antigravity saved the day", threadId: "agy-1", usage: usage(80, 20) };
      },
    };

    const config = testAgentConfig(home, { provider: "claude" });
    const first = await executeJobWithFallback({
      config,
      job: makeJob(),
      stagedAttachments: [],
      signal: new AbortController().signal,
      cooldown,
      runners,
      isCancelled: async () => false,
      loadFallbackContext: async () => null,
      onEvent: async () => {},
      onUsage: async () => {},
      onReady: () => {},
      onFallback: async (notice) => {
        fallbacks.push(notice);
      },
    });

    expect(first.provider).toBe("antigravity");
    expect(first.result.answer).toBe("antigravity saved the day");
    expect(first.result.threadId).toBe("agy-1");
    expect(first.usage).toEqual(usage(230, 20));
    expect(calls).toEqual(["claude", "codex", "antigravity"]);
    expect(fallbacks.map((f) => `${f.from}->${f.to}`)).toEqual([
      "claude->codex",
      "codex->antigravity",
    ]);
    expect(await readThreadState(home, "agy-1")).toMatchObject({ provider: "antigravity" });

    // While both Claude and Codex are in cooldown, next job skips straight to Antigravity.
    calls.length = 0;
    fallbacks.length = 0;
    const second = await executeJobWithFallback({
      config,
      job: makeJob({ id: 2, messageId: 11 }),
      stagedAttachments: [],
      signal: new AbortController().signal,
      cooldown,
      runners,
      isCancelled: async () => false,
      loadFallbackContext: async () => null,
      onEvent: async () => {},
      onUsage: async () => {},
      onReady: () => {},
      onFallback: async (notice) => {
        fallbacks.push(notice);
      },
    });
    expect(second.provider).toBe("antigravity");
    expect(calls).toEqual(["antigravity"]);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.from).toBe("claude");
    expect(fallbacks[0]?.to).toBe("antigravity");
    expect(fallbacks[0]?.skippedPrimary).toBe(true);
  });
});

test("transfers context across Claude -> Codex -> Antigravity and lets Codex threads fall back to Antigravity", async () => {
  await withWorkspace(async (home) => {
    const config = testAgentConfig(home, { provider: "claude" });
    await writeThreadState(home, "claude-session-2", {
      provider: "claude",
      injectedBuckets: ["profile.md:already-seen"],
    });
    const agyRuns: AgentRun[] = [];
    const fallbackContext: AgentJobFallbackContext = {
      contextMode: "full",
      context: "[2026-11-24T12:00:00.000Z] #1 User: first question",
      replyContext: "Telegram reply target: #2 Loylex: earlier answer",
      priorThread: "User (#1):\nfirst question\n\nAssistant:\nearlier answer",
    };

    const runners: Record<AgentProvider, ProviderRunner> = {
      claude: async (_config, run) => {
        await run.onEvent({ kind: "command", text: "git diff", threadId: "claude-session-2" });
        throw new AgentLimitError("claude", "Claude Code turn failed: weekly limit");
      },
      codex: async (_config, run) => {
        await run.onEvent({ kind: "command", text: "bun test", threadId: "codex-temp-2" });
        throw new AgentLimitError("codex", "You’ve hit your usage limit");
      },
      antigravity: async (_config, run) => {
        agyRuns.push(run);
        return { answer: "finished on antigravity", threadId: "agy-continued-1" };
      },
    };

    const res = await executeJobWithFallback({
      config,
      job: makeJob({ resumeThreadId: "claude-session-2", contextMode: "delta", context: "" }),
      stagedAttachments: [],
      signal: new AbortController().signal,
      cooldown: new ProviderLimitCooldown(),
      runners,
      isCancelled: async () => false,
      loadFallbackContext: async () => fallbackContext,
      onEvent: async () => {},
      onUsage: async () => {},
      onReady: () => {},
    });

    expect(res.provider).toBe("antigravity");
    expect(agyRuns[0]?.resumeThreadId).toBeNull();
    expect(agyRuns[0]?.instructions).toBe(agentInstructions("antigravity"));
    expect(agyRuns[0]?.prompt).toContain("earlier answer");
    expect(agyRuns[0]?.prompt).toContain("command: git diff");
    expect(agyRuns[0]?.prompt).toContain("command: bun test");
    expect(agyRuns[0]?.prompt).toContain("Private note about status.");

    // Existing Codex thread also falls back to Antigravity on Codex limit.
    await writeThreadState(home, "existing-codex-2", { provider: "codex", injectedBuckets: [] });
    agyRuns.length = 0;
    const codexRes = await executeJobWithFallback({
      config,
      job: makeJob({ resumeThreadId: "existing-codex-2" }),
      stagedAttachments: [],
      signal: new AbortController().signal,
      cooldown: new ProviderLimitCooldown(),
      runners,
      isCancelled: async () => false,
      loadFallbackContext: async () => fallbackContext,
      onEvent: async () => {},
      onUsage: async () => {},
      onReady: () => {},
    });
    expect(codexRes.provider).toBe("antigravity");
    expect(agyRuns).toHaveLength(1);
  });
});

test("reports combined 3-provider error and resets temporary thread ID when Antigravity also fails", async () => {
  await withWorkspace(async (home) => {
    const config = testAgentConfig(home, { provider: "claude" });
    let lastThreadId: string | null = null;
    const runners: Record<AgentProvider, ProviderRunner> = {
      claude: async (_config, run) => {
        await run.onEvent({ kind: "status", text: "Начинаю работу", threadId: "claude-dead" });
        throw new AgentLimitError("claude", "Claude Code turn failed: weekly limit");
      },
      codex: async (_config, run) => {
        await run.onEvent({ kind: "status", text: "Начинаю работу", threadId: "codex-dead" });
        throw new AgentLimitError("codex", "Codex usage limit");
      },
      antigravity: async (_config, run) => {
        await run.onEvent({ kind: "status", text: "Начинаю работу", threadId: "agy-dead" });
        throw new Error("Antigravity exited with 1: auth required");
      },
    };

    await expect(
      executeJobWithFallback({
        config,
        job: makeJob(),
        stagedAttachments: [],
        signal: new AbortController().signal,
        cooldown: new ProviderLimitCooldown(),
        runners,
        isCancelled: async () => false,
        loadFallbackContext: async () => null,
        onEvent: async () => {},
        onUsage: async () => {},
        onReady: () => {},
        onThreadId: (tid) => {
          lastThreadId = tid;
        },
      }),
    ).rejects.toThrow(
      "Claude Code turn failed: weekly limit; Codex fallback failed: Codex usage limit; Antigravity fallback failed: Antigravity exited with 1: auth required",
    );
    expect(lastThreadId).toBeNull();
  });
});
