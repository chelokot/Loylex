import { expect, test } from "bun:test";
import type { GatewayConfig } from "../src/gateway/config.ts";
import type { LoylexDatabase } from "../src/gateway/database.ts";
import { GatewayServer } from "../src/gateway/server.ts";
import type { TelegramClient } from "../src/gateway/telegram.ts";
import type { AgentCompletion, TelegramMessage } from "../src/shared/types.ts";
import type { AgentTokenUsage } from "../src/shared/usage.ts";

function botMessage(id: number): TelegramMessage {
  return {
    message_id: id,
    date: 1,
    chat: { id: -10042, type: "supergroup", title: "Test" },
  };
}

function config(): GatewayConfig {
  return {
    botToken: "unused",
    bridgeToken: "unused",
    databasePath: ":memory:",
    auditPath: "/audit/inbound.ndjson",
    listenHost: "127.0.0.1",
    listenPort: 8787,
    pollTimeoutSeconds: 1,
    contextMessages: 10,
  };
}

test("records usage from a worker", async () => {
  const recorded: {
    jobId: number;
    usage: AgentTokenUsage;
    workerId: string | undefined;
    threadId: string | null;
  }[] = [];
  const database = {
    recordUsage: (
      jobId: number,
      usage: AgentTokenUsage,
      workerId?: string,
      threadId?: string | null,
    ) => {
      recorded.push({ jobId, usage, workerId, threadId: threadId ?? null });
      return true;
    },
  } as unknown as LoylexDatabase;
  const server = new GatewayServer(config(), database, {} as TelegramClient);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;
  const usage: AgentTokenUsage = {
    inputTokens: 100,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 10,
    totalTokens: 120,
  };

  const response = await route.call(
    server,
    new Request("http://localhost/v1/jobs/7/usage", {
      method: "POST",
      headers: {
        authorization: "Bearer unused",
        "x-loylex-worker-id": "worker-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ usage, threadId: "thread-7" }),
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, recorded: true });
  expect(recorded).toEqual([{ jobId: 7, usage, workerId: "worker-1", threadId: "thread-7" }]);
});

test("rejects malformed usage payloads", async () => {
  let called = false;
  const database = {
    recordUsage: () => {
      called = true;
      return true;
    },
  } as unknown as LoylexDatabase;
  const server = new GatewayServer(config(), database, {} as TelegramClient);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;

  const response = await route.call(
    server,
    new Request("http://localhost/v1/jobs/7/usage", {
      method: "POST",
      headers: { authorization: "Bearer unused", "content-type": "application/json" },
      body: JSON.stringify({ usage: { inputTokens: -1 } }),
    }),
  );

  expect(response.status).toBe(400);
  expect(called).toBe(false);
});

test("returns the usage report with an optional chat filter", async () => {
  let requested: { chatId: number | null; limit: number } | null = null;
  const report = { generatedAt: 1, chatId: -10042, summary: {}, byUser: [] };
  const database = {
    usageReport: (chatId: number | null, limit: number) => {
      requested = { chatId, limit };
      return report;
    },
  } as unknown as LoylexDatabase;
  const server = new GatewayServer(config(), database, {} as TelegramClient);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;

  const response = await route.call(
    server,
    new Request("http://localhost/v1/usage?chat=-10042&limit=25", {
      headers: { authorization: "Bearer unused" },
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(report);
  expect(requested as { chatId: number | null; limit: number } | null).toEqual({
    chatId: -10042,
    limit: 25,
  });
});

test("steer delivery acknowledgements validate input and preserve Telegram topic", async () => {
  const sent: unknown[] = [];
  let recorded = false;
  const database = {
    finishSteer: (_job: number, _steer: number, worker: string, accepted: boolean) => {
      if (worker !== "worker-one" || recorded || !accepted) return null;
      recorded = true;
      return 42;
    },
    jobAddress: () => ({ chatId: -10042, threadId: 9 }),
  } as unknown as LoylexDatabase;
  const telegram = {
    sendRich: async (...args: unknown[]) => {
      sent.push(args);
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;
  const send = (body: unknown, worker = "worker-one") =>
    route.call(
      server,
      new Request("http://localhost/v1/jobs/1/steers/2", {
        method: "POST",
        headers: { authorization: "Bearer unused", "x-loylex-worker-id": worker },
        body: JSON.stringify(body),
      }),
    );
  expect((await send({ accepted: "true" })).status).toBe(400);
  expect(await (await send({ accepted: true }, "other-worker")).json()).toEqual({
    recorded: false,
  });
  expect(await (await send({ accepted: true })).json()).toEqual({ recorded: true });
  expect(await (await send({ accepted: true })).json()).toEqual({ recorded: false });
  expect(sent).toEqual([
    [-10042, "Уточнение передано в работающую задачу.", { replyTo: 42, threadId: 9 }],
  ]);
});

test("disabled progress retains internal status but sends only the final answer", async () => {
  for (const chatType of ["private", "supergroup"] as const) {
    const sent: string[] = [];
    let statusWrites = 0;
    const database = {
      jobAddress: () => ({ chatId: -10042, chatType, messageId: 10, threadId: null, userId: 42 }),
      progressEnabled: () => false,
      thinkingMessage: () => null,
      isJobCancelled: () => false,
      appendStatus: () => {
        statusWrites++;
        return "commentary: Working";
      },
      recordOutboundMessage: () => {},
      complete: () => true,
    } as unknown as LoylexDatabase;
    const telegram = {
      sendRich: async (_chatId: number, markdown: string) => {
        sent.push(markdown);
        return botMessage(11);
      },
      sendRichMessageDraft: async () => {
        throw new Error("unexpected draft");
      },
    } as unknown as TelegramClient;
    const server = new GatewayServer(config(), database, telegram, () => false);
    const methods = server as unknown as {
      event: (id: number, event: { kind: "commentary"; text: string }) => Promise<void>;
      complete: (id: number, completion: AgentCompletion) => Promise<void>;
    };
    await methods.event(7, { kind: "commentary", text: "Working" });
    expect(sent).toEqual([]);
    await methods.complete(7, { threadId: "thread", answer: "Done" });
    expect(sent).toEqual(["Done"]);
    expect(statusWrites).toBe(2);
  }
});
