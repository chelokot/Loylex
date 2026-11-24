import { expect, test } from "bun:test";
import type { GatewayConfig } from "../src/gateway/config.ts";
import type { LoylexDatabase } from "../src/gateway/database.ts";
import { GatewayServer } from "../src/gateway/server.ts";
import type { TelegramClient } from "../src/gateway/telegram.ts";
import type { TelegramMessage } from "../src/shared/types.ts";

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

test("forwards a message from a known source chat", async () => {
  let forwarded: { chatId: number; sourceChatId: number; messageId: number } | undefined;
  const database = {
    chatExists: (chatId: number) => chatId === -10042,
  } as unknown as LoylexDatabase;
  const telegram = {
    forwardMessage: async (chatId: number, sourceChatId: number, messageId: number) => {
      forwarded = { chatId, sourceChatId, messageId };
      return {
        ...botMessage(22),
        chat: { id: chatId, type: "channel" as const },
      };
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/forward", {
      method: "POST",
      headers: { authorization: "Bearer unused", "content-type": "application/json" },
      body: JSON.stringify({
        chatId: 4405504696,
        sourceChatId: -10042,
        messageId: 17,
      }),
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ chatId: 4405504696, messageId: 22 });
  expect(forwarded).toEqual({ chatId: 4405504696, sourceChatId: -10042, messageId: 17 });
});

test("rejects forwarding from an unknown source chat before calling Telegram", async () => {
  let called = false;
  const database = {
    chatExists: () => false,
  } as unknown as LoylexDatabase;
  const telegram = {
    forwardMessage: async () => {
      called = true;
      return botMessage(22);
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/forward", {
      method: "POST",
      headers: { authorization: "Bearer unused", "content-type": "application/json" },
      body: JSON.stringify({ chatId: 4405504696, sourceChatId: -10099, messageId: 17 }),
    }),
  );

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "unknown source chat" });
  expect(called).toBe(false);
});

test("rejects invalid forwarding IDs before calling Telegram", async () => {
  let called = false;
  const database = {
    chatExists: () => true,
  } as unknown as LoylexDatabase;
  const telegram = {
    forwardMessage: async () => {
      called = true;
      return botMessage(22);
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/forward", {
      method: "POST",
      headers: { authorization: "Bearer unused", "content-type": "application/json" },
      body: JSON.stringify({ chatId: 4405504696, sourceChatId: -10042, messageId: 0 }),
    }),
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "chatId, sourceChatId and messageId must be valid integer IDs",
  });
  expect(called).toBe(false);
});

test("copies a message from a known source chat", async () => {
  let copied: { chatId: number; sourceChatId: number; messageId: number } | undefined;
  const database = {
    chatExists: (chatId: number) => chatId === -10042,
  } as unknown as LoylexDatabase;
  const telegram = {
    copyMessage: async (chatId: number, sourceChatId: number, messageId: number) => {
      copied = { chatId, sourceChatId, messageId };
      return 23;
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/copy", {
      method: "POST",
      headers: { authorization: "Bearer unused", "content-type": "application/json" },
      body: JSON.stringify({ chatId: -10042, sourceChatId: -10042, messageId: 17 }),
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ chatId: -10042, messageId: 23 });
  expect(copied).toEqual({ chatId: -10042, sourceChatId: -10042, messageId: 17 });
});

test("calls an arbitrary Telegram API method with JSON parameters", async () => {
  let called: { method: string; parameters: Record<string, unknown> } | undefined;
  const database = {} as LoylexDatabase;
  const telegram = {
    call: async (method: string, parameters: Record<string, unknown>) => {
      called = { method, parameters };
      return { id: 42, type: "private" };
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/api", {
      method: "POST",
      headers: { authorization: "Bearer unused", "content-type": "application/json" },
      body: JSON.stringify({ method: "getChat", params: { chat_id: 42 } }),
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    method: "getChat",
    result: { id: 42, type: "private" },
  });
  expect(called).toEqual({ method: "getChat", parameters: { chat_id: 42 } });
});

test("calls an arbitrary Telegram API method with multipart files", async () => {
  let called:
    | {
        method: string;
        parameters: Record<string, unknown>;
        files: Array<{ field: string; file: File }>;
      }
    | undefined;
  const database = {} as LoylexDatabase;
  const telegram = {
    callMultipart: async (
      method: string,
      parameters: Record<string, unknown>,
      files: Array<{ field: string; file: File }>,
    ) => {
      called = { method, parameters, files };
      return true;
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;
  const form = new FormData();
  form.set("method", "sendPhoto");
  form.set("params", JSON.stringify({ chat_id: 42, photo: "attach://photo" }));
  form.set("photo", new File(["image"], "image.png", { type: "image/png" }));

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/api", {
      method: "POST",
      headers: { authorization: "Bearer unused" },
      body: form,
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ method: "sendPhoto", result: true });
  expect(called?.method).toBe("sendPhoto");
  expect(called?.parameters).toEqual({ chat_id: 42, photo: "attach://photo" });
  expect(called?.files).toHaveLength(1);
  expect(called?.files[0]?.field).toBe("photo");
  expect(called?.files[0]?.file.name).toBe("image.png");
});

test("rejects invalid universal Telegram API parameters", async () => {
  let called = false;
  const database = {} as LoylexDatabase;
  const telegram = {
    call: async () => {
      called = true;
      return true;
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/api", {
      method: "POST",
      headers: { authorization: "Bearer unused", "content-type": "application/json" },
      body: JSON.stringify({ method: "getChat", params: [42] }),
    }),
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "params must be a JSON object" });
  expect(called).toBe(false);
});

test("edits a caption in a known chat", async () => {
  let edited: { chatId: number; messageId: number; caption: string } | undefined;
  const database = {
    chatExists: (chatId: number) => chatId === -10042,
  } as unknown as LoylexDatabase;
  const telegram = {
    editMessageCaption: async (chatId: number, messageId: number, caption: string) => {
      edited = { chatId, messageId, caption };
      return true;
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/edit-caption", {
      method: "POST",
      headers: { authorization: "Bearer unused", "content-type": "application/json" },
      body: JSON.stringify({
        chatId: -10042,
        messageId: 17,
        caption: "Ключевые слова\nОбзывательства",
      }),
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ chatId: -10042, messageId: 17 });
  expect(edited).toEqual({
    chatId: -10042,
    messageId: 17,
    caption: "Ключевые слова\nОбзывательства",
  });
});

test("rejects caption edits in an unknown chat before calling Telegram", async () => {
  let called = false;
  const database = {
    chatExists: () => false,
  } as unknown as LoylexDatabase;
  const telegram = {
    editMessageCaption: async () => {
      called = true;
      return true;
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/edit-caption", {
      method: "POST",
      headers: { authorization: "Bearer unused", "content-type": "application/json" },
      body: JSON.stringify({ chatId: -10099, messageId: 17, caption: "Описание" }),
    }),
  );

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "unknown chat" });
  expect(called).toBe(false);
});

test("deletes a message in a known chat", async () => {
  const deleted: Array<{ chatId: number; messageId: number }> = [];
  const database = {
    chatExists: (chatId: number) => chatId === -10042,
  } as unknown as LoylexDatabase;
  const telegram = {
    deleteMessage: async (chatId: number, messageId: number) => {
      deleted.push({ chatId, messageId });
      return true;
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/delete", {
      method: "POST",
      headers: { authorization: "Bearer unused", "content-type": "application/json" },
      body: JSON.stringify({ chatId: -10042, messageId: 17 }),
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ chatId: -10042, messageId: 17, deleted: true });
  expect(deleted).toEqual([{ chatId: -10042, messageId: 17 }]);
});

test("rejects deletion for an unknown chat before calling Telegram", async () => {
  let called = false;
  const database = {
    chatExists: () => false,
  } as unknown as LoylexDatabase;
  const telegram = {
    deleteMessage: async () => {
      called = true;
      return true;
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/delete", {
      method: "POST",
      headers: { authorization: "Bearer unused", "content-type": "application/json" },
      body: JSON.stringify({ chatId: -10099, messageId: 17 }),
    }),
  );

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "unknown chat" });
  expect(called).toBe(false);
});

test("rejects invalid deletion IDs before calling Telegram", async () => {
  let called = false;
  const database = {
    chatExists: () => true,
  } as unknown as LoylexDatabase;
  const telegram = {
    deleteMessage: async () => {
      called = true;
      return true;
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/delete", {
      method: "POST",
      headers: { authorization: "Bearer unused", "content-type": "application/json" },
      body: JSON.stringify({ chatId: -10042, messageId: 0 }),
    }),
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "chatId and messageId must be valid integer IDs",
  });
  expect(called).toBe(false);
});
