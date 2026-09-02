import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoylexDatabase } from "../src/gateway/database.ts";
import type { TelegramMessage } from "../src/shared/types.ts";
import type { AgentTokenUsage } from "../src/shared/usage.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(): LoylexDatabase {
  const directory = mkdtempSync(join(tmpdir(), "loylex-privacy-"));
  directories.push(directory);
  return new LoylexDatabase(join(directory, "test.sqlite"));
}

function message(chatId: number, messageId: number, text: string): TelegramMessage {
  return {
    message_id: messageId,
    date: 1_700_000_000 + messageId,
    chat: { id: chatId, type: "private", title: "Privacy test" },
    from: { id: 7, is_bot: false, first_name: "Artem" },
    text,
  };
}

const usage: AgentTokenUsage = {
  inputTokens: 10,
  cachedInputTokens: 2,
  cacheWriteInputTokens: 0,
  outputTokens: 3,
  reasoningOutputTokens: 1,
  totalTokens: 13,
};

const formerlyExcludedChatId = 849670500;

test("archives and processes the formerly excluded chat like every other chat", () => {
  const database = setup();
  const incoming = message(formerlyExcludedChatId, 1, "секрет");
  const exported = message(formerlyExcludedChatId, 2, "экспорт");

  expect(database.archiveUpdate({ update_id: 1, message: incoming })).toEqual(incoming);
  expect(database.archiveExportMessages([exported])).toBe(1);
  expect(database.stats()).toEqual({ updates: 1, messages: 2, pendingJobs: 0, runningJobs: 0 });
  expect(database.nextUpdateOffset()).toBe(2);

  expect(database.chatExists(formerlyExcludedChatId)).toBe(true);
  expect(database.search("секрет", formerlyExcludedChatId, 10)).toHaveLength(1);
  expect(database.recent(formerlyExcludedChatId, 10)).toHaveLength(2);
  expect(database.archivedMessage(formerlyExcludedChatId, 1)?.text).toBe("секрет");
  expect(database.archivedMessages(formerlyExcludedChatId, null, null, 10)).toHaveLength(2);

  database.enqueue(3, message(formerlyExcludedChatId, 3, "запрос"), "запрос", null);
  const job = database.claimNext(10);
  expect(job).not.toBeNull();
  expect(job?.context).toContain("секрет");
  expect(job?.replyContext).toBeNull();
  expect(database.appendStatus(job?.id ?? 0, "секрет", "thread-secret")).toBe("секрет");
  expect(database.statusLog(job?.id ?? 0)).toBe("секрет");
  expect(database.recordUsage(job?.id ?? 0, usage, undefined, "thread-secret")).toBe(true);
  database.recordOutboundMessage(job?.id ?? 0, 10, "thread-secret");
  expect(
    database.connection
      .query<{ count: number }, []>("SELECT count(*) AS count FROM outbound_messages")
      .get()?.count,
  ).toBe(1);
  expect(database.complete(job?.id ?? 0, 11, "thread-secret", undefined, usage)).toBe(true);
  expect(
    database.connection
      .query<{ error: string | null }, [number]>("SELECT error FROM jobs WHERE id = ?")
      .get(job?.id ?? 0)?.error,
  ).toBeNull();
  expect(database.usageReport().summary.jobs).toBe(1);
  database.close();
});
