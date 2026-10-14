import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexCancelledError } from "../src/agent/codex.ts";
import { runCodexAppServer } from "../src/agent/codex-app-server.ts";
import type { AgentConfig } from "../src/agent/config.ts";
import type { AgentEvent } from "../src/shared/types.ts";

async function config(): Promise<AgentConfig> {
  const home = await mkdtemp(join(tmpdir(), "loylex-app-server-test-"));
  await mkdir(join(home, "sessions"));
  return {
    codexBinary: resolve("tests/fixtures/codex-app-server.py"),
    codexHome: home,
    repositoryPath: home,
    memoryPath: home,
    model: "test-model",
    reasoningEffort: "low",
    serviceTier: "priority",
    bridgeUrl: "",
    bridgeToken: "",
    pollIntervalMs: 1000,
    maxConcurrentJobs: 1,
  };
}

test("steers the same turn, preserves commentary and reports only current-run usage", async () => {
  const settings = await config();
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  try {
    const result = await runCodexAppServer(
      settings,
      "original",
      "thread-test",
      async (event) => {
        events.push(event);
      },
      controller.signal,
      async () => {},
      (control) => {
        if (control)
          void control.send("steered answer", "telegram-123").catch(() => controller.abort());
      },
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
        "original",
        null,
        async () => {},
        controller.signal,
        async () => {},
        (control) => {
          if (control)
            void control.send("reject", "telegram-124").catch((error) => {
              rejection = error.message;
              controller.abort();
            });
        },
      ),
    ).rejects.toBeInstanceOf(CodexCancelledError);
    expect(rejection).toBe("no active turn");
  } finally {
    await rm(settings.codexHome, { recursive: true, force: true });
  }
});
