import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoylexDatabase } from "../src/gateway/database.ts";
import type { TelegramMessage, TelegramUpdate } from "../src/shared/types.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(): LoylexDatabase {
  const directory = mkdtempSync(join(tmpdir(), "loylex-db-"));
  directories.push(directory);
  return new LoylexDatabase(join(directory, "test.sqlite"));
}

function message(id: number, text: string): TelegramMessage {
  return {
    message_id: id,
    date: 1_700_000_000 + id,
    chat: { id: -10042, type: "supergroup", title: "Test" },
    from: { id: 7, is_bot: false, first_name: "Andrii", username: "chelokot" },
    text,
  };
}

function botMessage(id: number, text: string): TelegramMessage {
  return {
    message_id: id,
    date: 1_700_000_000 + id,
    chat: { id: -10042, type: "supergroup", title: "Test" },
    from: { id: 99, is_bot: true, first_name: "Loylex" },
    text,
  };
}

describe("LoylexDatabase", () => {
  test("migrates the normalized archive schema used by the previous gateway", () => {
    const directory = mkdtempSync(join(tmpdir(), "loylex-normalized-"));
    directories.push(directory);
    const path = join(directory, "test.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE chats (
        chat_id INTEGER PRIMARY KEY,
        chat_type TEXT NOT NULL,
        chat_title TEXT
      );
      CREATE TABLE users (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        display_name TEXT
      );
      CREATE TABLE messages (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        message_thread_id INTEGER,
        date INTEGER NOT NULL,
        edit_date INTEGER,
        from_user_id INTEGER,
        text TEXT,
        reply_to_message_id INTEGER,
        media_group_id TEXT,
        media_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'bot_api',
        PRIMARY KEY (chat_id, message_id),
        FOREIGN KEY (chat_id) REFERENCES chats(chat_id),
        FOREIGN KEY (from_user_id) REFERENCES users(user_id)
      );
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        text,
        from_display_name,
        from_username,
        content='',
        contentless_delete=1,
        tokenize='unicode61'
      );
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text, from_display_name, from_username)
        SELECT new.rowid, new.text, users.display_name, users.username
        FROM (SELECT 1) AS one
        LEFT JOIN users ON users.user_id = new.from_user_id;
      END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
      END;
      CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
        INSERT INTO messages_fts(rowid, text, from_display_name, from_username)
        SELECT new.rowid, new.text, users.display_name, users.username
        FROM (SELECT 1) AS one
        LEFT JOIN users ON users.user_id = new.from_user_id;
      END;
      INSERT INTO chats VALUES (-10042, 'supergroup', 'Test');
      INSERT INTO users VALUES (7, 'legacyuser', 'Legacy');
    `);
    const legacyMessage = {
      ...message(1, "legacy message"),
      from: { id: 7, is_bot: false, first_name: "Legacy", username: "legacyuser" },
    };
    legacy
      .query(`
        INSERT INTO messages (
          chat_id, message_id, message_thread_id, date, edit_date, from_user_id, text,
          reply_to_message_id, media_group_id, media_json, raw_json, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        legacyMessage.chat.id,
        legacyMessage.message_id,
        null,
        legacyMessage.date,
        null,
        legacyMessage.from.id,
        legacyMessage.text ?? null,
        null,
        null,
        "[]",
        JSON.stringify(legacyMessage),
        "bot_api",
      );
    legacy.close();

    const database = new LoylexDatabase(path);
    const columns = database.connection
      .query<{ name: string }, []>("PRAGMA table_info(messages)")
      .all()
      .map((column) => column.name);
    expect(columns).toEqual(
      expect.arrayContaining(["chat_type", "chat_title", "from_username", "from_display_name"]),
    );
    expect(
      database.connection
        .query<
          {
            chat_type: string;
            chat_title: string | null;
            from_username: string | null;
            from_display_name: string | null;
          },
          [number, number]
        >(
          "SELECT chat_type, chat_title, from_username, from_display_name FROM messages WHERE chat_id = ? AND message_id = ?",
        )
        .get(-10042, 1),
    ).toEqual({
      chat_type: "supergroup",
      chat_title: "Test",
      from_username: "legacyuser",
      from_display_name: "Legacy",
    });
    expect(database.search("legacyuser", null, 10).map((result) => result.messageId)).toEqual([1]);

    const newMessage = message(2, "new message");
    newMessage.chat = { id: -10043, type: "group", title: "New chat" };
    newMessage.from = { id: 8, is_bot: false, first_name: "New", username: "newuser" };
    expect(() => database.archiveMessage(newMessage, "bot_api")).not.toThrow();
    expect(database.search("newuser", -10043, 10).map((result) => result.messageId)).toEqual([2]);
    expect(
      database.connection
        .query("SELECT chat_type, chat_title FROM messages WHERE chat_id = ?")
        .get(-10043),
    ).toEqual({ chat_type: "group", chat_title: "New chat" });
    database.close();

    const reopened = new LoylexDatabase(path);
    expect(reopened.search("newuser", -10043, 10).map((result) => result.messageId)).toEqual([2]);
    reopened.close();
  });

  test("archives, indexes, claims, and resumes a thread", () => {
    const database = setup();
    database.archiveMessage(message(1, "предыдущий контекст"), "bot_api");
    const incoming = message(2, "Лойлекс, запомни этот контекст");
    const update: TelegramUpdate = { update_id: 55, message: incoming };
    database.archiveUpdate(update);
    database.enqueue(55, incoming, "запомни этот контекст", null);

    database.archiveMessage(message(3, "сообщение после индикатора"), "bot_api");

    const job = database.claimNext(10);
    expect(job?.prompt).toBe("запомни этот контекст");
    expect(job?.context).toContain("@chelokot");
    expect(job?.context).toContain("user_id=7");
    expect(job?.context).toContain("#1");
    expect(job?.context).not.toContain("#2");
    expect(job?.contextMode).toBe("full");
    expect(database.search("запомни", -10042, 10)).toHaveLength(1);
    expect(database.recent(-10042, 2).map((item) => item.messageId)).toEqual([3, 2]);
    expect(database.recent(-10042, 1)[0]?.userId).toBe(7);

    database.complete(job?.id ?? 0, 99, "thread-123");
    expect(database.resumeThread(-10042, 99)).toBe("thread-123");
    database.close();
  });

  test("passes only new chat messages when resuming a Codex thread", () => {
    const database = setup();
    const incoming = message(1, "Лойлекс, начни задачу");
    database.archiveMessage(incoming, "bot_api");
    database.enqueue(55, incoming, "начни задачу", null);

    const first = database.claimNext(10);
    expect(first).not.toBeNull();
    database.appendStatus(first?.id ?? 0, "commentary: работаю", "thread-123");
    database.complete(first?.id ?? 0, 2, "thread-123");
    database.archiveMessage(botMessage(2, "Готово"), "bot_api");

    database.archiveMessage(message(3, "сообщение между запросами"), "bot_api");
    const followUp = message(4, "продолжай");
    database.archiveMessage(followUp, "bot_api");
    database.enqueue(56, followUp, "продолжай", "thread-123");

    const resumed = database.claimNext(10);
    expect(resumed?.contextMode).toBe("delta");
    expect(resumed?.context).toContain("#3");
    expect(resumed?.context).not.toContain("#1");
    expect(resumed?.context).not.toContain("#2");
    expect(resumed?.context).not.toContain("#4");
    database.close();
  });

  test("claims and completes an operator command without a Codex thread", () => {
    const database = setup();
    const incoming = message(1, "/exec pwd");
    incoming.chat = { id: 849670500, type: "private" };
    incoming.from = { id: 849670500, is_bot: false, first_name: "Operator" };
    database.archiveUpdate({ update_id: 55, message: incoming });
    database.enqueueOperatorCommand(55, incoming, "pwd");

    const job = database.claimNext(10);
    expect(job).toMatchObject({
      kind: "operator_exec",
      command: "pwd",
      prompt: "/exec pwd",
      resumeThreadId: null,
    });
    expect(database.complete(job?.id ?? 0, 99, null)).toBe(true);
    expect(database.resumeThread(849670500, 99)).toBeNull();
    database.close();
  });

  test("serializes jobs for one Codex thread without blocking unrelated threads", () => {
    const database = setup();
    const first = message(1, "первая задача");
    const second = message(2, "вторая задача");
    const unrelated = message(3, "другая задача");
    database.enqueue(55, first, "первая", "thread-123");
    database.enqueue(56, second, "вторая", "thread-123");
    database.enqueue(57, unrelated, "другая", "thread-456");

    const firstJob = database.claimNext(10, "worker-a");
    expect(firstJob?.messageId).toBe(1);
    const unrelatedJob = database.claimNext(10, "worker-b");
    expect(unrelatedJob?.messageId).toBe(3);
    expect(database.claimNext(10, "worker-c")).toBeNull();

    expect(database.complete(firstJob?.id ?? 0, 11, "thread-123", "worker-a")).toBe(true);
    const secondJob = database.claimNext(10, "worker-c");
    expect(secondJob?.messageId).toBe(2);
    expect(database.complete(unrelatedJob?.id ?? 0, 12, "thread-456", "worker-b")).toBe(true);
    database.close();
  });

  test("keeps old-generation work with the draining worker", () => {
    const database = setup();
    expect(database.registerWorker("blue", 1_000)).toEqual({ generation: 1, state: "active" });

    const old = message(1, "старая задача");
    const oldFollowUp = message(2, "старое продолжение");
    database.enqueue(55, old, "старая", null);
    database.enqueue(56, oldFollowUp, "продолжай старое", "thread-old");

    const oldJob = database.claimNext(10, "blue");
    expect(oldJob?.messageId).toBe(1);
    database.appendStatus(oldJob?.id ?? 0, "commentary: работаю", "thread-old", "blue");

    expect(database.registerWorker("green", 2_000)).toEqual({ generation: 2, state: "active" });
    const newMessage = message(3, "новая задача");
    database.enqueue(57, newMessage, "новая", null);

    expect(database.claimNext(10, "blue")).toBeNull();
    expect(database.shouldDrainWorker("blue")).toBe(false);

    expect(database.complete(oldJob?.id ?? 0, 101, "thread-old", "blue")).toBe(true);
    const oldContinuation = database.claimNext(10, "blue");
    expect(oldContinuation?.messageId).toBe(2);
    expect(database.complete(oldContinuation?.id ?? 0, 102, "thread-old", "blue")).toBe(true);
    expect(database.shouldDrainWorker("blue")).toBe(true);

    const newJob = database.claimNext(10, "green");
    expect(newJob?.messageId).toBe(3);
    expect(database.complete(newJob?.id ?? 0, 103, "thread-new", "green")).toBe(true);
    database.close();
  });

  test("reassigns queued old-generation work when a worker stops", () => {
    const database = setup();
    database.registerWorker("blue", 1_000);
    const old = message(1, "старая очередь");
    database.enqueue(55, old, "старая", null);
    database.registerWorker("green", 2_000);

    expect(database.stopWorker("blue", 3_000)).toBe(true);
    const reassigned = database.claimNext(10, "green");
    expect(reassigned?.messageId).toBe(1);
    expect(database.complete(reassigned?.id ?? 0, 101, "thread-new", "green")).toBe(true);
    database.close();
  });

  test("updates edited messages without duplicating them", () => {
    const database = setup();
    database.archiveMessage(message(2, "первая версия"), "bot_api");
    database.archiveMessage(message(2, "исправленная версия"), "bot_api");

    expect(database.stats().messages).toBe(1);
    expect(database.search("исправленная", null, 10)[0]?.messageId).toBe(2);
    expect(database.search("первая", null, 10)).toHaveLength(0);
    database.close();
  });

  test("cancels active jobs linked to an outbound message and its Codex thread", () => {
    const database = setup();
    const incoming = message(1, "Лойлекс, начни долгую работу");
    database.archiveUpdate({ update_id: 55, message: incoming });
    database.enqueue(55, incoming, "начни долгую работу", null);

    const running = database.claimNext(10);
    expect(running).not.toBeNull();
    const runningJobId = running?.id ?? 0;
    database.setThinkingMessage(runningJobId, 10);
    database.appendStatus(runningJobId, "commentary: работаю", "thread-123");

    const queued = message(2, "продолжай");
    database.enqueue(56, queued, "продолжай", "thread-123");

    expect(database.cancelJobsForMessage(-10042, 10)).toEqual([runningJobId, runningJobId + 1]);
    expect(database.isJobCancelled(runningJobId)).toBe(true);
    expect(database.complete(runningJobId, 99, "thread-123")).toBe(false);
    expect(database.claimNext(10)).toBeNull();
    database.close();
  });

  test("lists the latest jobs for one chat with their current state", () => {
    const database = setup();
    const incoming = message(1, "Лойлекс, проверь очередь");
    database.archiveUpdate({ update_id: 55, message: incoming });
    database.enqueue(55, incoming, "проверь очередь", null);

    const running = database.claimNext(10);
    expect(running).not.toBeNull();
    const runningJobId = running?.id ?? 0;
    database.setThinkingMessage(runningJobId, 10);
    database.complete(runningJobId, 11, "thread-123");

    const queued = message(2, "Лойлекс, подожди");
    database.enqueue(56, queued, "подожди", null);

    expect(database.listRecentJobs(-10042)).toEqual([
      {
        id: runningJobId + 1,
        chatId: -10042,
        chatType: "supergroup",
        messageId: 2,
        prompt: "подожди",
        state: "pending",
        createdAt: expect.any(Number),
        completedAt: null,
        thinkingMessageId: null,
        canResume: false,
      },
      {
        id: runningJobId,
        chatId: -10042,
        chatType: "supergroup",
        messageId: 1,
        prompt: "проверь очередь",
        state: "completed",
        createdAt: expect.any(Number),
        completedAt: expect.any(Number),
        thinkingMessageId: 10,
        canResume: false,
      },
    ]);
    database.close();
  });
});
