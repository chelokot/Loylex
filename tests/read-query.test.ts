import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoylexDatabase } from "../src/gateway/database.ts";
import {
  maxReadQueryRows,
  ReadQueryError,
  validateReadOnlyQuery,
} from "../src/gateway/read-query.ts";
import type { TelegramMessage } from "../src/shared/types.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(): LoylexDatabase {
  const directory = mkdtempSync(join(tmpdir(), "loylex-read-query-"));
  directories.push(directory);
  return new LoylexDatabase(join(directory, "test.sqlite"));
}

function message(messageId: number, text: string): TelegramMessage {
  return {
    message_id: messageId,
    date: 1_700_000_000 + messageId,
    chat: { id: -10042, type: "supergroup", title: "Test" },
    from: { id: 7, is_bot: false, first_name: "Andrii" },
    text,
  };
}

test("runs parameterized archive queries with chronological results and a truncation flag", () => {
  const database = setup();
  database.archiveMessage(message(3, "лейло третье"), "bot_api");
  database.archiveMessage(message(1, "лейло первое"), "bot_api");
  database.archiveMessage(message(2, "не совпадает"), "bot_api");

  const result = database.readQuery(
    `
      SELECT message_id, date, text
      FROM messages
      WHERE chat_id = ? AND text LIKE ?
      ORDER BY date ASC, message_id ASC
    `,
    [-10042, "%лейло%"],
    1,
  );

  expect(result.columns).toEqual(["message_id", "date", "text"]);
  expect(result.rows).toEqual([{ message_id: 1, date: 1_700_000_001, text: "лейло первое" }]);
  expect(result.truncated).toBe(true);
  expect(database.stats().messages).toBe(3);
  database.close();
});

test("supports read-only CTEs and rejects mutations, attachment, and extra statements", () => {
  const database = setup();
  database.archiveMessage(message(1, "проверка"), "bot_api");

  const result = database.readQuery(
    "WITH selected AS (SELECT message_id FROM messages WHERE chat_id = ?) SELECT * FROM selected",
    [-10042],
  );
  expect(result.rows).toEqual([{ message_id: 1 }]);

  for (const sql of [
    "UPDATE messages SET text = 'сломано'",
    "WITH selected AS (SELECT 1) DELETE FROM messages",
    "PRAGMA user_version",
    "ATTACH DATABASE '/tmp/other.sqlite' AS other",
    "SELECT message_id FROM messages; DELETE FROM messages",
  ]) {
    expect(() => database.readQuery(sql)).toThrow(ReadQueryError);
  }

  expect(database.readQuery("SELECT text FROM messages WHERE message_id = 1").rows).toEqual([
    { text: "проверка" },
  ]);
  database.close();
});

test("validates query and result limits", () => {
  expect(() => validateReadOnlyQuery("")).toThrow("sql is required");
  expect(() =>
    validateReadOnlyQuery("WITH selected AS (SELECT 1) UPDATE messages SET text = 'x'"),
  ).toThrow(ReadQueryError);

  const database = setup();
  expect(() => database.readQuery("SELECT 1", [], maxReadQueryRows + 1)).toThrow(
    `maxRows must be an integer from 1 to ${maxReadQueryRows}`,
  );
  database.close();
});
