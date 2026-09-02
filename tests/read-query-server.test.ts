import { expect, test } from "bun:test";
import type { GatewayConfig } from "../src/gateway/config.ts";
import type { LoylexDatabase, ReadQueryResult } from "../src/gateway/database.ts";
import { GatewayServer } from "../src/gateway/server.ts";
import type { TelegramClient } from "../src/gateway/telegram.ts";

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

function route(server: GatewayServer): (request: Request) => Promise<Response> {
  return (server as unknown as { route: (request: Request) => Promise<Response> }).route.bind(
    server,
  );
}

test("routes parameterized read-only archive queries through the database", async () => {
  let requested: { sql: string; params: unknown; maxRows: number } | null = null;
  const result: ReadQueryResult = {
    columns: ["message_id"],
    rows: [{ message_id: 1 }],
    truncated: false,
  };
  const database = {
    readQuery: (sql: string, params: unknown, maxRows: number) => {
      requested = { sql, params, maxRows };
      return result;
    },
  } as unknown as LoylexDatabase;
  const server = new GatewayServer(config(), database, {} as TelegramClient);

  const response = await route(server)(
    new Request("http://localhost/v1/archive/query", {
      method: "POST",
      headers: { authorization: "Bearer unused", "content-type": "application/json" },
      body: JSON.stringify({
        sql: "SELECT message_id FROM messages WHERE chat_id = ?",
        params: [-10042],
        maxRows: 25,
      }),
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
  expect(requested as { sql: string; params: unknown; maxRows: number } | null).toEqual({
    sql: "SELECT message_id FROM messages WHERE chat_id = ?",
    params: [-10042],
    maxRows: 25,
  });
});

test("rejects malformed read-query parameters and limits before touching the database", async () => {
  let called = false;
  const database = {
    readQuery: () => {
      called = true;
      return { columns: [], rows: [], truncated: false };
    },
  } as unknown as LoylexDatabase;
  const server = new GatewayServer(config(), database, {} as TelegramClient);

  const response = await route(server)(
    new Request("http://localhost/v1/archive/query", {
      method: "POST",
      headers: { authorization: "Bearer unused", "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1", params: { bad: 1 }, maxRows: 10_001 }),
    }),
  );

  expect(response.status).toBe(400);
  expect(called).toBe(false);
});
