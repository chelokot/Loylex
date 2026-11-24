import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentCancelledError,
  AgentLimitError,
  type AgentProvider,
  type AgentRun,
} from "../src/agent/agent-run.ts";
import { loadAgentConfig } from "../src/agent/config.ts";
import { agentInstructions } from "../src/agent/prompt.ts";
import {
  executeJobWithFallback,
  type FallbackNotice,
  ProviderLimitCooldown,
  type ProviderRunner,
} from "../src/agent/provider-runner.ts";
import { readThreadState, writeThreadState } from "../src/agent/thread-state.ts";
import type { GatewayConfig } from "../src/gateway/config.ts";
import type { LoylexDatabase } from "../src/gateway/database.ts";
import { GatewayServer } from "../src/gateway/server.ts";
import type { TelegramClient } from "../src/gateway/telegram.ts";
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

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withWorkspace(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "loylex-provider-runner-"));
  try {
    await mkdir(join(home, "buckets"), { recursive: true });
    await writeFile(
      join(home, "buckets", "index.json"),
      JSON.stringify({
        buckets: [
          {
            file: "profile.md",
            terms: ["статус"],
          },
        ],
      }),
    );
    await writeFile(join(home, "buckets", "profile.md"), "Private note about status.");
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("loadAgentConfig defaults to Claude Code and still allows explicit Codex rollback", async () => {
  await withEnv(
    {
      LOYLEX_BRIDGE_TOKEN: "test-token",
      LOYLEX_BRIDGE_TOKEN_FILE: undefined,
      LOYLEX_AGENT_PROVIDER: undefined,
    },
    () => {
      expect(loadAgentConfig().provider).toBe("claude");
    },
  );
  await withEnv(
    {
      LOYLEX_BRIDGE_TOKEN: "test-token",
      LOYLEX_BRIDGE_TOKEN_FILE: undefined,
      LOYLEX_AGENT_PROVIDER: "codex",
    },
    () => {
      expect(loadAgentConfig().provider).toBe("codex");
    },
  );
});

test("ProviderLimitCooldown bounds reset windows, defaults unknown resets, and expires cleanly", () => {
  let now = 1_000_000;
  const cooldown = new ProviderLimitCooldown({
    now: () => now,
    defaultCooldownMs: 300_000,
    maxCooldownMs: 900_000,
    minCooldownMs: 5_000,
  });

  expect(cooldown.isLimited("claude")).toBe(false);

  // Uses exact resetsAt when within [min, max]
  expect(cooldown.recordLimit("claude", now + 120_000)).toBe(now + 120_000);
  expect(cooldown.isLimited("claude")).toBe(true);
  now += 120_000;
  expect(cooldown.isLimited("claude")).toBe(false);

  // Caps far-future weekly limit at maxCooldownMs
  expect(cooldown.recordLimit("claude", now + 7 * 86_400_000)).toBe(now + 900_000);
  cooldown.clear("claude");
  expect(cooldown.isLimited("claude")).toBe(false);

  // Floors near-immediate reset at minCooldownMs
  expect(cooldown.recordLimit("claude", now + 1_000)).toBe(now + 5_000);
  cooldown.clear("claude");

  // Defaults when resetsAt is unknown or in the past
  expect(cooldown.recordLimit("claude", null)).toBe(now + 300_000);
  cooldown.clear("claude");
  expect(cooldown.recordLimit("claude", now - 5_000)).toBe(now + 300_000);
});

test("falls back from Claude Code to Codex on limit, arms cooldown, and returns to Claude after expiry", async () => {
  await withWorkspace(async (home) => {
    let now = 10_000;
    const cooldown = new ProviderLimitCooldown({
      now: () => now,
      defaultCooldownMs: 60_000,
      maxCooldownMs: 300_000,
    });
    const calls: { provider: AgentProvider; run: AgentRun }[] = [];
    const fallbacks: FallbackNotice[] = [];
    const observedUsage: { usage: AgentTokenUsage; threadId: string }[] = [];
    let claudeShouldLimit = true;

    const runners: Record<AgentProvider, ProviderRunner> = {
      claude: async (_config, run) => {
        calls.push({ provider: "claude", run });
        await run.onEvent({ kind: "status", text: "Начинаю работу", threadId: "claude-temp-1" });
        if (claudeShouldLimit) {
          await run.onUsage(usage(100, 0), "claude-temp-1");
          throw new AgentLimitError(
            "claude",
            "Claude Code turn failed: You've hit your limit",
            now + 120_000,
          );
        }
        return { answer: "claude answer", threadId: "claude-ok-1", usage: usage(50, 20) };
      },
      codex: async (_config, run) => {
        calls.push({ provider: "codex", run });
        await run.onEvent({ kind: "status", text: "Начинаю работу", threadId: "codex-1" });
        await run.onUsage(usage(200, 40), "codex-1");
        return { answer: "codex fallback answer", threadId: "codex-1", usage: usage(200, 40) };
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
      onUsage: async (u, tid) => {
        observedUsage.push({ usage: u, threadId: tid });
      },
      onReady: () => {},
      onFallback: async (notice) => {
        fallbacks.push(notice);
      },
    });

    expect(first.provider).toBe("codex");
    expect(first.result.answer).toBe("codex fallback answer");
    expect(first.result.threadId).toBe("codex-1");
    expect(first.usage).toEqual(usage(300, 40));
    expect(observedUsage.at(-1)).toEqual({ usage: usage(300, 40), threadId: "codex-1" });
    expect(calls.map((c) => c.provider)).toEqual(["claude", "codex"]);
    expect(calls[1]?.run.instructions).toBe(agentInstructions("codex"));
    expect(calls[1]?.run.resumeThreadId).toBeNull();
    expect(await readThreadState(home, "codex-1")).toEqual({
      provider: "codex",
      injectedBuckets: [expect.stringMatching(/^profile\.md:/)],
    });
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.skippedPrimary).toBe(false);
    expect(fallbacks[0]?.cooldownUntilMs).toBe(now + 120_000);

    // While cooldown is active, next new thread skips Claude completely.
    calls.length = 0;
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
    expect(second.provider).toBe("codex");
    expect(calls.map((c) => c.provider)).toEqual(["codex"]);
    expect(fallbacks.at(-1)?.skippedPrimary).toBe(true);

    // After cooldown expires, new threads go back to Claude Code.
    now += 120_001;
    claudeShouldLimit = false;
    calls.length = 0;
    const third = await executeJobWithFallback({
      config,
      job: makeJob({ id: 3, messageId: 12 }),
      stagedAttachments: [],
      signal: new AbortController().signal,
      cooldown,
      runners,
      isCancelled: async () => false,
      loadFallbackContext: async () => null,
      onEvent: async () => {},
      onUsage: async () => {},
      onReady: () => {},
    });
    expect(third.provider).toBe("claude");
    expect(third.result.answer).toBe("claude answer");
    expect(calls.map((c) => c.provider)).toEqual(["claude"]);
    expect(await readThreadState(home, "claude-ok-1")).toMatchObject({ provider: "claude" });
  });
});

test("resumed Claude thread transfers full context, prior turns, private buckets, and interrupted work to Codex", async () => {
  await withWorkspace(async (home) => {
    const config = testAgentConfig(home, { provider: "claude" });
    await writeThreadState(home, "claude-session-1", {
      provider: "claude",
      injectedBuckets: ["profile.md:already-seen"],
    });
    const codexRuns: AgentRun[] = [];
    let loadedFallbackContext = false;
    const fallbackContext: AgentJobFallbackContext = {
      contextMode: "full",
      context: "[2026-11-24T12:00:00.000Z] #1 User: first question",
      replyContext: "Telegram reply target: #2 Loylex: earlier detailed answer",
      priorThread: "User (#1):\nfirst question\n\nAssistant:\nearlier detailed answer",
    };

    const runners: Record<AgentProvider, ProviderRunner> = {
      claude: async (_config, run) => {
        await run.onEvent({ kind: "command", text: "git status", threadId: "claude-session-1" });
        throw new AgentLimitError("claude", "Claude Code turn failed: Rate limit reached");
      },
      codex: async (_config, run) => {
        codexRuns.push(run);
        return { answer: "continued on codex", threadId: "codex-continued-1" };
      },
    };

    const result = await executeJobWithFallback({
      config,
      job: makeJob({
        resumeThreadId: "claude-session-1",
        contextMode: "delta",
        context: "",
        replyContext:
          "Telegram reply target: #2, an earlier message of this conversation shown above.",
      }),
      stagedAttachments: [],
      signal: new AbortController().signal,
      cooldown: new ProviderLimitCooldown(),
      runners,
      isCancelled: async () => false,
      loadFallbackContext: async () => {
        loadedFallbackContext = true;
        return fallbackContext;
      },
      onEvent: async () => {},
      onUsage: async () => {},
      onReady: () => {},
    });

    expect(loadedFallbackContext).toBe(true);
    expect(result.provider).toBe("codex");
    expect(result.result.threadId).toBe("codex-continued-1");
    const codexRun = codexRuns[0];
    expect(codexRun).toBeDefined();
    expect(codexRun?.resumeThreadId).toBeNull();
    expect(codexRun?.prompt).toContain("<LOYLEX_UNTRUSTED_PRIOR_THREAD>");
    expect(codexRun?.prompt).toContain("earlier detailed answer");
    expect(codexRun?.prompt).toContain("Recent Telegram context:");
    expect(codexRun?.prompt).toContain("Telegram reply target: #2 Loylex: earlier detailed answer");
    expect(codexRun?.prompt).toContain("Private note about status.");
    expect(codexRun?.prompt).toContain("command: git status");
    expect(await readThreadState(home, "codex-continued-1")).toMatchObject({ provider: "codex" });
    // Original Claude thread state stays intact.
    expect(await readThreadState(home, "claude-session-1")).toEqual({
      provider: "claude",
      injectedBuckets: ["profile.md:already-seen"],
    });
  });
});

test("does not fall back on non-limit errors or cancellation, and keeps Codex threads on Codex", async () => {
  await withWorkspace(async (home) => {
    const config = testAgentConfig(home, { provider: "claude" });
    const cooldown = new ProviderLimitCooldown();
    let codexCalls = 0;

    const runners: Record<AgentProvider, ProviderRunner> = {
      claude: async (_config, run) => {
        if (run.prompt.includes("cancel-me")) throw new AgentCancelledError();
        throw new Error("Claude Code turn failed: invalid_request");
      },
      codex: async () => {
        codexCalls += 1;
        return { answer: "codex", threadId: "codex-thread" };
      },
    };

    await expect(
      executeJobWithFallback({
        config,
        job: makeJob({ prompt: "ordinary error" }),
        stagedAttachments: [],
        signal: new AbortController().signal,
        cooldown,
        runners,
        isCancelled: async () => false,
        loadFallbackContext: async () => null,
        onEvent: async () => {},
        onUsage: async () => {},
        onReady: () => {},
      }),
    ).rejects.toThrow("invalid_request");
    expect(codexCalls).toBe(0);
    expect(cooldown.isLimited("claude")).toBe(false);

    await expect(
      executeJobWithFallback({
        config,
        job: makeJob({ prompt: "cancel-me" }),
        stagedAttachments: [],
        signal: new AbortController().signal,
        cooldown,
        runners,
        isCancelled: async () => true,
        loadFallbackContext: async () => null,
        onEvent: async () => {},
        onUsage: async () => {},
        onReady: () => {},
      }),
    ).rejects.toBeInstanceOf(AgentCancelledError);
    expect(codexCalls).toBe(0);

    // Existing Codex thread runs directly on Codex even when Claude is default.
    await writeThreadState(home, "existing-codex", { provider: "codex", injectedBuckets: [] });
    const codexResult = await executeJobWithFallback({
      config,
      job: makeJob({ resumeThreadId: "existing-codex" }),
      stagedAttachments: [],
      signal: new AbortController().signal,
      cooldown,
      runners,
      isCancelled: async () => false,
      loadFallbackContext: async () => null,
      onEvent: async () => {},
      onUsage: async () => {},
      onReady: () => {},
    });
    expect(codexResult.provider).toBe("codex");
    expect(codexCalls).toBe(1);
  });
});

test("reports combined error and resets temporary Claude thread ID if Codex fallback also fails", async () => {
  await withWorkspace(async (home) => {
    const config = testAgentConfig(home, { provider: "claude" });
    let lastThreadId: string | null = null;
    const runners: Record<AgentProvider, ProviderRunner> = {
      claude: async (_config, run) => {
        await run.onEvent({ kind: "status", text: "Начинаю работу", threadId: "claude-dead" });
        throw new AgentLimitError("claude", "Claude Code turn failed: You've hit your limit");
      },
      codex: async () => {
        throw new Error("Codex app-server exited with 1");
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
      "You've hit your limit; Codex fallback failed: Codex app-server exited with 1",
    );
    expect(lastThreadId).toBeNull();
  });
});

test("gateway serves job fallback context only to the owning worker", async () => {
  const payload: AgentJobFallbackContext = {
    contextMode: "full",
    context: "recent chat",
    replyContext: "Telegram reply target: #2 Loylex: prior answer",
    priorThread: "User (#1):\nhi\n\nAssistant:\nprior answer",
  };
  const database = {
    fallbackContext: (jobId: number, limit: number, worker?: string) =>
      jobId === 7 && limit === 10 && worker === "worker-one" ? payload : null,
  } as unknown as LoylexDatabase;
  const gatewayConfig: GatewayConfig = {
    botToken: "unused",
    bridgeToken: "unused",
    databasePath: ":memory:",
    auditPath: "/audit/inbound.ndjson",
    listenHost: "127.0.0.1",
    listenPort: 8787,
    pollTimeoutSeconds: 1,
    contextMessages: 10,
  };
  const server = new GatewayServer(gatewayConfig, database, {} as TelegramClient);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;

  const denied = await route.call(
    server,
    new Request("http://localhost/v1/jobs/7/fallback-context", {
      headers: { authorization: "Bearer unused", "x-loylex-worker-id": "other-worker" },
    }),
  );
  expect(denied.status).toBe(404);

  const ok = await route.call(
    server,
    new Request("http://localhost/v1/jobs/7/fallback-context", {
      headers: { authorization: "Bearer unused", "x-loylex-worker-id": "worker-one" },
    }),
  );
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual(payload);
});
