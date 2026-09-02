import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoylexDatabase } from "../src/gateway/database.ts";
import { chatIdFromUpdate, GDPR_EXCLUDED_CHAT_ID } from "../src/shared/privacy.ts";
import type { TelegramMessage, TelegramUpdate } from "../src/shared/types.ts";
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

test("keeps the excluded live message unarchived and detects nested chat updates", () => {
  const database = setup();
  const excluded = message(GDPR_EXCLUDED_CHAT_ID, 1, "секрет");
  const update: TelegramUpdate = { update_id: 1, message: excluded };

  expect(chatIdFromUpdate(update)).toBe(GDPR_EXCLUDED_CHAT_ID);
  expect(
    chatIdFromUpdate({
      update_id: 2,
      callback_query: { message: excluded },
    }),
  ).toBe(GDPR_EXCLUDED_CHAT_ID);
  expect(database.archiveUpdate(update)).toEqual(excluded);
  expect(database.archiveExportMessages([excluded])).toBe(0);
  expect(database.stats()).toEqual({ updates: 0, messages: 0, pendingJobs: 0, runningJobs: 0 });
  expect(database.nextUpdateOffset()).toBe(2);
  database.close();
});

test("excludes old rows from reads, context, usage, and outbound logging", () => {
  const database = setup();
  const allowed = message(-10042, 2, "обычное");
  const excluded = message(GDPR_EXCLUDED_CHAT_ID, 3, "секрет");
  database.archiveUpdate({ update_id: 2, message: allowed });

  database.connection
    .query("INSERT INTO chats (chat_id, chat_type, chat_title) VALUES (?, ?, ?)")
    .run(GDPR_EXCLUDED_CHAT_ID, "private", "Privacy test");
  database.connection
    .query(
      `INSERT INTO messages (
         chat_id, message_id, date, from_user_id, text, media_json, raw_json, source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      excluded.chat.id,
      excluded.message_id,
      excluded.date,
      excluded.from?.id ?? null,
      excluded.text ?? null,
      "[]",
      JSON.stringify(excluded),
      "bot_api",
    );
  database.connection
    .query("INSERT INTO updates (update_id, event_type, received_at, raw_json) VALUES (?, ?, ?, ?)")
    .run(3, "message", Date.now(), JSON.stringify({ update_id: 3, message: excluded }));

  expect(database.chatExists(GDPR_EXCLUDED_CHAT_ID)).toBe(false);
  expect(database.search("секрет", null, 10)).toEqual([]);
  expect(database.recent(GDPR_EXCLUDED_CHAT_ID, 10)).toEqual([]);
  expect(database.archivedMessage(GDPR_EXCLUDED_CHAT_ID, 3)).toBeNull();
  expect(database.archivedMessages(GDPR_EXCLUDED_CHAT_ID, null, null, 10)).toEqual([]);
  expect(database.archivedMedia(GDPR_EXCLUDED_CHAT_ID, 10)).toEqual([]);
  expect(database.stats()).toEqual({ updates: 1, messages: 1, pendingJobs: 0, runningJobs: 0 });

  database.enqueue(4, excluded, "секрет", null);
  const job = database.claimNext(10);
  expect(job).not.toBeNull();
  expect(job?.context).toBe("");
  expect(job?.replyContext).toBeNull();
  expect(database.appendStatus(job?.id ?? 0, "секрет", "thread-secret")).toBe("секрет");
  expect(database.statusLog(job?.id ?? 0)).toBeNull();
  expect(database.recordUsage(job?.id ?? 0, usage, undefined, "thread-secret")).toBe(false);
  database.recordOutboundMessage(job?.id ?? 0, 10, "thread-secret");
  expect(
    database.connection
      .query<{ count: number }, []>("SELECT count(*) AS count FROM outbound_messages")
      .get()?.count,
  ).toBe(0);
  expect(database.complete(job?.id ?? 0, 10, "thread-secret", undefined, usage)).toBe(true);
  expect(
    database.connection
      .query<{ error: string | null }, [number]>("SELECT error FROM jobs WHERE id = ?")
      .get(job?.id ?? 0)?.error,
  ).toBeNull();
  expect(database.usageReport().summary.jobs).toBe(0);
  database.close();
});
