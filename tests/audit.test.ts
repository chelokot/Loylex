import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboundAuditLog } from "../src/gateway/audit.ts";
import type { TelegramMessage, TelegramUpdate } from "../src/shared/types.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "loylex-audit-"));
  directories.push(directory);
  const path = join(directory, "inbound.ndjson");
  writeFileSync(path, "");
  return { directory, path };
}

function message(chatId = -10042, messageId = 7): TelegramMessage {
  return {
    message_id: messageId,
    message_thread_id: 12,
    date: 1_700_000_007,
    chat: { id: chatId, type: "supergroup", title: "not logged" },
    from: { id: 426043802, is_bot: false, first_name: "not logged", username: "not_logged" },
    text: "Лойлекс проверь журнал",
    document: { file_id: "not logged" },
  };
}

function update(messageValue: TelegramMessage, updateId = 99): TelegramUpdate {
  return { update_id: updateId, message: messageValue };
}

test("durably appends a minimal message record without names or media", async () => {
  const { path } = setup();
  const audit = new InboundAuditLog(path, () => "2026-09-02T12:00:00.000Z");

  await audit.assertReady();
  await expect(audit.append(update(message()))).resolves.toBe(true);

  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  expect(parsed).toEqual({
    version: 1,
    received_at: "2026-09-02T12:00:00.000Z",
    update_id: 99,
    event: "message",
    chat_id: -10042,
    message_id: 7,
    message_thread_id: 12,
    telegram_date: 1_700_000_007,
    author_id: 426043802,
    text: "Лойлекс проверь журнал",
  });
  expect(Object.keys(parsed)).not.toContain("title");
  expect(Object.keys(parsed)).not.toContain("username");
  expect(Object.keys(parsed)).not.toContain("document");
});

test("audits every chat, including the formerly excluded address", async () => {
  const { path } = setup();
  const audit = new InboundAuditLog(path, () => "2026-09-02T12:01:00.000Z");

  await audit.append(update(message(849670500, 8), 100));

  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    chat_id: 849670500,
    message_id: 8,
    author_id: 426043802,
  });
});

test("records the sender chat as the author for channel posts", async () => {
  const { path } = setup();
  const audit = new InboundAuditLog(path, () => "2026-09-02T12:01:30.000Z");
  const channelPost = message(-10043, 9);
  delete channelPost.from;
  channelPost.sender_chat = { id: -10043, type: "channel", title: "not logged" };

  await audit.append({ update_id: 101, channel_post: channelPost });

  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    event: "channel_post",
    author_id: -10043,
  });
});

test("serializes concurrent appends as complete JSON lines", async () => {
  const { path } = setup();
  const audit = new InboundAuditLog(path, () => "2026-09-02T12:02:00.000Z");

  await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
      audit.append(update(message(-10042, index + 1), index + 1)),
    ),
  );

  const lines = readFileSync(path, "utf8").trim().split("\n");
  expect(lines).toHaveLength(16);
  expect(lines.map((line) => JSON.parse(line).update_id).sort((a, b) => a - b)).toEqual(
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
});

test("fails closed when the audit file is absent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loylex-audit-missing-"));
  directories.push(directory);
  const path = join(directory, "missing.ndjson");
  const audit = new InboundAuditLog(path);

  await expect(audit.assertReady()).rejects.toThrow();
  await expect(audit.append(update(message()))).rejects.toThrow();
});
