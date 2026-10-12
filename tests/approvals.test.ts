import { expect, test } from "bun:test";
import { ApprovalClient } from "../src/gateway/approvals.ts";
import { LoylexDatabase } from "../src/gateway/database.ts";
import { GatewayServer } from "../src/gateway/server.ts";
import type { TelegramClient } from "../src/gateway/telegram.ts";
import type { JsonObject } from "../src/shared/types.ts";

test("gateway protects approval messages across JSON, multipart and dedicated mutation routes", async () => {
  const checked: Array<{ method: string; params: JsonObject }> = [];
  const broker = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer gateway-only");
      const payload = (await request.json()) as { method: string; params: JsonObject };
      checked.push(payload);
      return Response.json({ allowed: false });
    },
  });
  const database = new LoylexDatabase(":memory:");
  database.archiveMessage(
    {
      message_id: 10,
      date: 1,
      chat: { id: -100, type: "supergroup" },
      from: { id: 1, is_bot: false, first_name: "Test" },
      text: "request",
    },
    "bot_api",
  );
  let calls = 0;
  const telegram = {
    call: async () => {
      calls++;
      return true;
    },
    callMultipart: async () => {
      calls++;
      return true;
    },
    deleteMessage: async () => {
      calls++;
      return true;
    },
    editMessageCaption: async () => {
      calls++;
      return true;
    },
  } as unknown as TelegramClient;
  const server = new GatewayServer(
    {
      botToken: "unused",
      bridgeToken: "agent",
      databasePath: ":memory:",
      auditPath: "/unused",
      listenHost: "127.0.0.1",
      listenPort: 0,
      pollTimeoutSeconds: 1,
      contextMessages: 10,
    },
    database,
    telegram,
    () => true,
    new ApprovalClient("gateway-only", broker.url.origin),
  );
  server.start();
  const route = (server as unknown as { route(request: Request): Promise<Response> }).route.bind(
    server,
  );
  try {
    for (const method of [
      "editMessageText",
      "EDITMESSAGEREPLYMARKUP",
      "deleteMessages",
      "setWebhook",
      "getUpdates",
    ]) {
      const response = await route(
        new Request("http://localhost/v1/telegram/api", {
          method: "POST",
          headers: { authorization: "Bearer agent", "content-type": "application/json" },
          body: JSON.stringify({
            method,
            params: { chat_id: -100, message_id: 101, message_ids: [101] },
          }),
        }),
      );
      expect(response.status).toBe(403);
    }
    const form = new FormData();
    form.set("method", "editMessageMedia");
    form.set("params", JSON.stringify({ chat_id: -100, message_id: 101 }));
    form.set("media", new File(["image"], "image.png"));
    expect(
      (
        await route(
          new Request("http://localhost/v1/telegram/api", {
            method: "POST",
            headers: { authorization: "Bearer agent" },
            body: form,
          }),
        )
      ).status,
    ).toBe(403);
    for (const endpoint of ["delete", "edit-caption"]) {
      expect(
        (
          await route(
            new Request(`http://localhost/v1/telegram/${endpoint}`, {
              method: "POST",
              headers: { authorization: "Bearer agent", "content-type": "application/json" },
              body: JSON.stringify({ chatId: -100, messageId: 101, caption: "replacement" }),
            }),
          )
        ).status,
      ).toBe(403);
    }
    expect(checked).toHaveLength(8);
    expect(calls).toBe(0);
    broker.stop(true);
    await expect(
      new ApprovalClient("gateway-only", broker.url.origin).guard("deleteMessage", {
        chat_id: -100,
        message_id: 101,
      }),
    ).rejects.toThrow();
  } finally {
    server.stop();
    broker.stop(true);
    database.close();
  }
});

test("ordinary messaging does not depend on the approval broker", async () => {
  const client = new ApprovalClient("gateway-only", "http://127.0.0.1:1");
  await client.guard("sendMessage", { chat_id: -100, text: "normal reply" });
  await client.guard("getChat", { chat_id: -100 });
});
