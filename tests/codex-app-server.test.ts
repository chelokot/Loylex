import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentCancelledError, type AgentRun } from "../src/agent/agent-run.ts";
import { runCodexAppServer } from "../src/agent/codex-app-server.ts";
import type { AgentConfig } from "../src/agent/config.ts";
import { workDocument } from "../src/gateway/presentation.ts";
import type { AgentEvent } from "../src/shared/types.ts";
import { testAgentConfig } from "./fixtures/agent-config.ts";

async function config(): Promise<AgentConfig> {
  const home = await mkdtemp(join(tmpdir(), "loylex-app-server-test-"));
  await mkdir(join(home, "sessions"));
  return testAgentConfig(home, { codexBinary: resolve("tests/fixtures/codex-app-server.py") });
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
test("steers the same turn, preserves commentary and reports only current-run usage", async () => {
  const settings = await config();
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  try {
    const result = await runCodexAppServer(
      settings,
      run({
        resumeThreadId: "thread-test",
        signal: controller.signal,
        onEvent: async (event) => {
          events.push(event);
        },
        onReady: (control) => {
          if (control)
            void control.send("steered answer", "telegram-123").catch(() => controller.abort());
        },
      }),
    );
    expect(result.answer).toBe("steered answer");
    expect(result.threadId).toBe("thread-test");
    expect(result.usage?.totalTokens).toBe(30);
    expect(events).toContainEqual({ kind: "commentary", text: "working", threadId: "thread-test" });
    expect(events.some((event) => event.kind === "command")).toBe(true);
  } finally {
    await rm(settings.codexHome, { recursive: true, force: true });
  }
});

test("a rejected steer is explicit and the active run can still be stopped", async () => {
  const settings = await config();
  const controller = new AbortController();
  let rejection = "";
  try {
    await expect(
      runCodexAppServer(
        settings,
        run({
          signal: controller.signal,
          onReady: (control) => {
            if (control)
              void control.send("reject", "telegram-124").catch((error) => {
                rejection = error.message;
                controller.abort();
              });
          },
        }),
      ),
    ).rejects.toBeInstanceOf(AgentCancelledError);
    expect(rejection).toBe("no active turn");
  } finally {
    await rm(settings.codexHome, { recursive: true, force: true });
  }
});

test("passes a journal-only web search into Telegram work history", async () => {
  const settings = await config();
  const events: AgentEvent[] = [];
  try {
    const result = await runCodexAppServer(
      settings,
      run({
        prompt: "journal",
        onEvent: async (event) => {
          events.push(event);
        },
      }),
    );
    expect(result.answer).toBe("Done");
    const tools = events.filter((event) => event.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(workDocument(`tool: ${tools[0]?.text}`)).toContain("France M51.3");
  } finally {
    await rm(settings.codexHome, { recursive: true, force: true });
  }
});
