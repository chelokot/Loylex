import { afterEach, expect, test } from "bun:test";
import type { GatewayConfig } from "../src/gateway/config.ts";
import type { LoylexDatabase } from "../src/gateway/database.ts";
import { ReadQueryError } from "../src/gateway/read-query.ts";
import { runReadQuery } from "../src/gateway/read-query-process.ts";
import { GatewayServer } from "../src/gateway/server.ts";
import type { TelegramClient } from "../src/gateway/telegram.ts";
import { message, removeDatabases, setup } from "./fixtures/database.ts";

afterEach(removeDatabases);

function config(databasePath: string): GatewayConfig {
  return {
    botToken: "unused",
    bridgeToken: "unused",
    databasePath,
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

function archiveQuery(body: unknown): Request {
  return new Request("http://localhost/v1/archive/query", {
    method: "POST",
    headers: { authorization: "Bearer unused", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const endlessQuery =
  "WITH RECURSIVE counter(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM counter) SELECT count(*) FROM counter";

test("runs parameterized read-only archive queries against the gateway database file", async () => {
  const database = setup();
  database.archiveMessage(message(1, "лейло первое"), "bot_api");
  database.archiveMessage(message(2, "не совпадает"), "bot_api");
  const server = new GatewayServer(
    config(database.connection.filename),
    database,
    {} as TelegramClient,
  );

  const response = await route(server)(
    archiveQuery({
      sql: "SELECT message_id, text FROM messages WHERE chat_id = ? AND text LIKE ?",
      params: [-10042, "%лейло%"],
      maxRows: 25,
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    columns: ["message_id", "text"],
    rows: [{ message_id: 1, text: "лейло первое" }],
    truncated: false,
  });
  database.close();
});

test("keeps the gateway responsive while an archive query runs", async () => {
  const database = setup();
  const server = new GatewayServer(
    config(database.connection.filename),
    database,
    {} as TelegramClient,
  );
  let queryFinished = false;
  const query = route(server)(
    archiveQuery({
      sql: "WITH RECURSIVE counter(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM counter WHERE value < 3000000) SELECT count(*) AS total FROM counter",
    }),
  ).then((response) => {
    queryFinished = true;
    return response;
  });

  await Bun.sleep(50);
  const health = await route(server)(new Request("http://localhost/healthz"));

  expect(health.status).toBe(200);
  expect(queryFinished).toBe(false);
  expect(await (await query).json()).toEqual({
    columns: ["total"],
    rows: [{ total: 3_000_000 }],
    truncated: false,
  });
  database.close();
});

test("stops archive queries that run past the time limit", async () => {
  const database = setup();
  const startedAt = performance.now();

  const query = runReadQuery(
    { databasePath: database.connection.filename, sql: endlessQuery, params: [], maxRows: 1 },
    300,
  );

  await expect(query).rejects.toThrow(ReadQueryError);
  await expect(query).rejects.toThrow("query ran longer than the 0.3-second limit");
  expect(performance.now() - startedAt).toBeLessThan(5_000);
  database.close();
});

test("returns archive results larger than a pipe buffer", async () => {
  const database = setup();

  const result = await runReadQuery({
    databasePath: database.connection.filename,
    sql: "WITH RECURSIVE counter(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM counter WHERE value < 5000) SELECT value, hex(zeroblob(100)) AS filler FROM counter",
    params: [],
    maxRows: 10_000,
  });

  expect(result.rows).toHaveLength(5_000);
  expect(result.truncated).toBe(false);
  database.close();
});

test("reports invalid archive queries as client errors", async () => {
  const database = setup();
  const server = new GatewayServer(
    config(database.connection.filename),
    database,
    {} as TelegramClient,
  );

  const mutation = await route(server)(archiveQuery({ sql: "DELETE FROM messages" }));
  const missingColumn = await route(server)(archiveQuery({ sql: "SELECT missing FROM messages" }));
  const malformed = await route(server)(
    archiveQuery({ sql: "SELECT 1", params: { bad: 1 }, maxRows: 10_001 }),
  );

  expect(mutation.status).toBe(400);
  expect(missingColumn.status).toBe(400);
  expect(await missingColumn.json()).toEqual({
    error: "read-only query failed: no such column: missing",
  });
  expect(malformed.status).toBe(400);
  database.close();
});

test("persists a mode correction through the authenticated bridge", async () => {
  const changes: unknown[] = [];
  const database = {
    setLeylobucksEnabled: (userId: number, enabled: boolean) => changes.push([userId, enabled]),
    isLeylobucksEnabled: () => false,
  } as unknown as LoylexDatabase;
  const server = new GatewayServer(config(":memory:"), database, {} as TelegramClient);
  const request = (authorization: string, userId: unknown, enabled: unknown) =>
    new Request("http://localhost/v1/leylobucks/mode", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ userId, enabled }),
    });
  expect((await route(server)(request("Bearer wrong", 7, false))).status).toBe(401);
  expect((await route(server)(request("Bearer unused", "7", false))).status).toBe(400);
  expect(changes).toEqual([]);
  const response = await route(server)(request("Bearer unused", 7, false));
  expect(await response.json()).toEqual({ userId: 7, enabled: false });
  expect(changes).toEqual([[7, false]]);
});
