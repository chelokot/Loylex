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

test("uploads an album to a known chat", async () => {
  type UploadFile = Blob & { readonly name: string };
  const uploads: Array<{ chatId: number; files: UploadFile[]; caption: string | null }> = [];
  const database = {
    chatExists: (chatId: number) => chatId === -10042,
  } as unknown as LoylexDatabase;
  const telegram = {
    sendMediaGroup: async (
      chatId: number,
      files: ReadonlyArray<UploadFile>,
      caption: string | null,
    ) => {
      uploads.push({ chatId, files: [...files], caption });
      return [botMessage(18), botMessage(19)];
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;
  const form = new FormData();
  form.set("chat_id", "-10042");
  form.append("file", new File(["one"], "one.png", { type: "image/png" }));
  form.append("file", new File(["two"], "two.png", { type: "image/png" }));
  form.set("caption", "Графики");

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/upload-album", {
      method: "POST",
      headers: { authorization: "Bearer unused" },
      body: form,
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ chatId: -10042, messageIds: [18, 19] });
  expect(uploads).toHaveLength(1);
  const uploaded = uploads[0];
  if (uploaded === undefined) {
    throw new Error("album was not uploaded");
  }
  expect(uploaded.chatId).toBe(-10042);
  expect(uploaded.files.map((file) => file.name)).toEqual(["one.png", "two.png"]);
  expect(uploaded.caption).toBe("Графики");
});

test("uploads a document with thread and reply options", async () => {
  let upload:
    | {
        chatId: number;
        file: File;
        caption: string | null;
        options: { replyTo?: number; threadId?: number | null };
      }
    | undefined;
  const database = {
    chatExists: (chatId: number) => chatId === -10042,
  } as unknown as LoylexDatabase;
  const telegram = {
    sendDocument: async (
      chatId: number,
      file: File,
      _filename: string,
      caption: string | null,
      options: { replyTo?: number; threadId?: number | null },
    ) => {
      upload = { chatId, file, caption, options };
      return botMessage(20);
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;
  const form = new FormData();
  form.set("chat_id", "-10042");
  form.set("file", new File(["image"], "result.png", { type: "image/png" }));
  form.set("reply_to", "17");
  form.set("thread_id", "12");

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/upload", {
      method: "POST",
      headers: { authorization: "Bearer unused" },
      body: form,
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ chatId: -10042, messageId: 20 });
  expect(upload).toMatchObject({
    chatId: -10042,
    caption: null,
    options: { replyTo: 17, threadId: 12 },
  });
  expect(upload?.file.name).toBe("result.png");
});

test("uploads an animation with thread and reply options", async () => {
  let upload:
    | {
        chatId: number;
        file: File;
        caption: string | null;
        options: { replyTo?: number; threadId?: number | null };
      }
    | undefined;
  const database = {
    chatExists: (chatId: number) => chatId === -10042,
  } as unknown as LoylexDatabase;
  const telegram = {
    sendAnimation: async (
      chatId: number,
      file: File,
      _filename: string,
      caption: string | null,
      options: { replyTo?: number; threadId?: number | null },
    ) => {
      upload = { chatId, file, caption, options };
      return botMessage(21);
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;
  const form = new FormData();
  form.set("chat_id", "-10042");
  form.set("file", new File(["animation"], "reaction.gif", { type: "image/gif" }));
  form.set("caption", "Реакция");
  form.set("reply_to", "17");
  form.set("thread_id", "12");

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/upload-animation", {
      method: "POST",
      headers: { authorization: "Bearer unused" },
      body: form,
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ chatId: -10042, messageId: 21 });
  expect(upload).toMatchObject({
    chatId: -10042,
    caption: "Реакция",
    options: { replyTo: 17, threadId: 12 },
  });
  expect(upload?.file.name).toBe("reaction.gif");
});

test("uploads a voice message with thread and reply options", async () => {
  let upload:
    | {
        chatId: number;
        file: File;
        caption: string | null;
        options: { replyTo?: number; threadId?: number | null };
      }
    | undefined;
  const database = {
    chatExists: (chatId: number) => chatId === -10042,
  } as unknown as LoylexDatabase;
  const telegram = {
    sendVoice: async (
      chatId: number,
      file: File,
      _filename: string,
      caption: string | null,
      options: { replyTo?: number; threadId?: number | null },
    ) => {
      upload = { chatId, file, caption, options };
      return botMessage(21);
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(config(), database, telegram);
  const route = (server as unknown as { route: (request: Request) => Promise<Response> }).route;
  const form = new FormData();
  form.set("chat_id", "-10042");
  form.set("file", new File(["voice"], "voice.ogg", { type: "audio/ogg" }));
  form.set("caption", "Голос");
  form.set("reply_to", "17");
  form.set("thread_id", "12");

  const response = await route.call(
    server,
    new Request("http://localhost/v1/telegram/upload-voice", {
      method: "POST",
      headers: { authorization: "Bearer unused" },
      body: form,
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ chatId: -10042, messageId: 21 });
  expect(upload).toMatchObject({
    chatId: -10042,
    caption: "Голос",
    options: { replyTo: 17, threadId: 12 },
  });
  expect(upload?.file.name).toBe("voice.ogg");
});
