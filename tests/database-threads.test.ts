import { afterEach, describe, expect, test } from "bun:test";
import type { JsonObject, TelegramMessage, TelegramUpdate } from "../src/shared/types.ts";

import {
  botMessage,
  message,
  privateMessage,
  removeDatabases,
  setup,
} from "./fixtures/database.ts";

afterEach(removeDatabases);

describe("LoylexDatabase", () => {
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

  test("does not append an identical progress update twice", () => {
    const database = setup();
    const incoming = message(1, "Лойлекс, начни задачу");
    database.enqueue(55, incoming, "начни задачу", null);

    const job = database.claimNext(10, "worker-a");
    expect(job).not.toBeNull();
    expect(
      database.appendStatus(job?.id ?? 0, "commentary: проверяю", "thread-123", "worker-a"),
    ).toBe("commentary: проверяю");
    expect(
      database.appendStatus(job?.id ?? 0, "commentary: проверяю", "thread-123", "worker-a"),
    ).toBeNull();
    expect(
      database.appendStatus(job?.id ?? 0, "commentary: исправляю", "thread-123", "worker-a"),
    ).toBe("commentary: проверяю\n\ncommentary: исправляю");
    database.close();
  });

  test("resumes a public group Codex thread for a different Telegram user", () => {
    const database = setup();
    const ownerMessage = message(1, "Лойлекс, начни задачу");
    database.archiveMessage(ownerMessage, "bot_api");
    database.enqueue(55, ownerMessage, "начни задачу", null);

    const ownerJob = database.claimNext(10);
    expect(ownerJob).not.toBeNull();
    database.appendStatus(ownerJob?.id ?? 0, "commentary: работаю", "thread-owned");
    database.complete(ownerJob?.id ?? 0, 2, "thread-owned");
    database.archiveMessage(botMessage(2, "Готово"), "bot_api");

    const otherUserMessage = {
      ...message(3, "продолжай чужую задачу"),
      from: { id: 8, is_bot: false, first_name: "Artem", username: "ExposedCat" },
    } satisfies TelegramMessage;
    database.archiveMessage(otherUserMessage, "bot_api");
    database.enqueue(56, otherUserMessage, "продолжай чужую задачу", "thread-owned");

    const freshJob = database.claimNext(10);
    expect(freshJob?.resumeThreadId).toBe("thread-owned");
    expect(freshJob?.contextMode).toBe("delta");
    expect(freshJob?.context).not.toContain("#1");
    database.close();
  });

  test("keeps private thread ownership bound to the Telegram user", () => {
    const database = setup();
    const ownerMessage = privateMessage(1, "начни приватную задачу");
    database.archiveMessage(ownerMessage, "bot_api");
    database.enqueue(55, ownerMessage, "начни приватную задачу", null);

    const ownerJob = database.claimNext(10);
    expect(ownerJob).not.toBeNull();
    database.appendStatus(ownerJob?.id ?? 0, "commentary: работаю", "thread-private");
    database.complete(ownerJob?.id ?? 0, 2, "thread-private");

    const otherUserMessage = {
      ...privateMessage(3, "продолжай чужую задачу"),
      from: { id: 8, is_bot: false, first_name: "Other" },
    } satisfies TelegramMessage;
    database.archiveMessage(otherUserMessage, "bot_api");
    database.enqueue(56, otherUserMessage, "продолжай чужую задачу", "thread-private");

    const freshJob = database.claimNext(10);
    expect(freshJob?.resumeThreadId).toBeNull();
    expect(freshJob?.contextMode).toBe("full");
    database.close();
  });

  test("does not include prior chat context for a clean new chat", () => {
    const database = setup();
    const first = privateMessage(1, "старое сообщение из предыдущего чата");
    database.archiveMessage(first, "bot_api");
    database.enqueue(55, first, "первая задача", null);

    const firstJob = database.claimNext(10);
    expect(firstJob).not.toBeNull();
    database.complete(firstJob?.id ?? 0, 2, "thread-old");

    const fresh = privateMessage(3, "новый чистый чат");
    fresh.reply_to_message = first;
    database.archiveMessage(fresh, "bot_api");
    database.enqueue(56, fresh, "новый чистый чат", null, "none");

    const freshJob = database.claimNext(10);
    expect(freshJob?.contextMode).toBe("none");
    expect(freshJob?.context).toBe("");
    expect(freshJob?.replyContext).toBeNull();
    expect(freshJob?.context).not.toContain("старое сообщение");
    database.close();
  });

  test("finds the latest private thread and resolves replies to job messages", () => {
    const database = setup();
    const first = privateMessage(1, "первая задача");
    database.archiveMessage(first, "bot_api");
    database.enqueue(55, first, "первая задача", null);

    const firstJob = database.claimNext(10);
    expect(firstJob).not.toBeNull();
    database.complete(firstJob?.id ?? 0, 2, "thread-one");

    expect(database.latestThread(42)).toBe("thread-one");
    expect(database.latestContinuableThread(42)).toBe("thread-one");
    expect(database.resumeThread(42, 2)).toBe("thread-one");
    expect(database.resumeThread(42, 1)).toBe("thread-one");

    const second = privateMessage(3, "вторая задача");
    database.archiveMessage(second, "bot_api");
    database.enqueue(56, second, "вторая задача", "thread-one");
    const secondJob = database.claimNext(10);
    expect(secondJob?.resumeThreadId).toBe("thread-one");
    database.complete(secondJob?.id ?? 0, 4, "thread-two");

    expect(database.latestThread(42)).toBe("thread-two");
    database.close();
  });

  test("starts a separate private thread while the latest thread is busy", () => {
    const database = setup();
    const first = privateMessage(1, "долгая задача");
    database.archiveMessage(first, "bot_api");
    database.enqueue(55, first, "долгая задача", null);

    const firstJob = database.claimNext(10);
    expect(firstJob).not.toBeNull();
    database.appendStatus(firstJob?.id ?? 0, "commentary: работаю", "thread-one");
    expect(database.latestContinuableThread(42)).toBeNull();

    const parallel = privateMessage(3, "параллельная задача");
    database.archiveMessage(parallel, "bot_api");
    const parallelResumeThreadId = database.latestContinuableThread(42);
    expect(parallelResumeThreadId).toBeNull();
    database.enqueue(56, parallel, "параллельная задача", parallelResumeThreadId);

    const parallelJob = database.claimNext(10);
    expect(parallelJob?.messageId).toBe(3);
    expect(parallelJob?.resumeThreadId).toBeNull();
    expect(database.complete(parallelJob?.id ?? 0, 4, "thread-two")).toBe(true);
    expect(database.latestContinuableThread(42)).toBe("thread-two");

    expect(database.complete(firstJob?.id ?? 0, 5, "thread-one")).toBe(true);
    database.close();
  });

  test("serializes jobs for one Codex thread without blocking unrelated threads", () => {
    const database = setup();
    const first = message(1, "первая задача");
    const second = message(2, "вторая задача");
    const unrelated = message(3, "другая задача");
    database.enqueue(55, first, "первая", null);
    const firstJob = database.claimNext(10, "worker-a");
    expect(firstJob?.messageId).toBe(1);
    database.appendStatus(firstJob?.id ?? 0, "commentary: работаю", "thread-123", "worker-a");
    database.enqueue(56, second, "вторая", "thread-123");
    database.enqueue(57, unrelated, "другая", null);

    const unrelatedJob = database.claimNext(10, "worker-b");
    expect(unrelatedJob?.messageId).toBe(3);
    expect(database.claimNext(10, "worker-c")).toBeNull();

    expect(database.complete(firstJob?.id ?? 0, 11, "thread-123", "worker-a")).toBe(true);
    const secondJob = database.claimNext(10, "worker-c");
    expect(secondJob?.messageId).toBe(2);
    expect(database.complete(unrelatedJob?.id ?? 0, 12, "thread-456", "worker-b")).toBe(true);
    database.close();
  });

  test("finds only an active Codex thread for an edited source message", () => {
    const database = setup();
    const incoming = message(3, "Лойлекс, начни работу");
    database.archiveMessage(incoming, "bot_api");
    database.enqueue(57, incoming, "начни работу", "thread-active");

    expect(database.activeThreadForMessage(-10042, 3)).toBe("thread-active");
    expect(database.activeThreadForMessage(-10042, 3, 7)).toBe("thread-active");
    expect(database.activeThreadForMessage(-10042, 3, 99)).toBeNull();
    const running = database.claimNext(10);
    expect(running?.messageId).toBe(3);
    expect(database.cancelJobsForMessage(-10042, 3)).toEqual([running?.id ?? 0]);
    expect(database.activeThreadForMessage(-10042, 3)).toBeNull();

    database.enqueue(58, incoming, "уже завершено", "thread-done");
    const completed = database.claimNext(10);
    expect(completed).not.toBeNull();
    expect(database.complete(completed?.id ?? 0, 4, "thread-done")).toBe(true);
    expect(database.activeThreadForMessage(-10042, 3)).toBeNull();
    database.close();
  });

  test("passes attachments from a replied-to message into the job", () => {
    const database = setup();
    const document = {
      file_id: "reply-file-id",
      file_name: "app.zip",
      mime_type: "application/zip",
      file_size: 123,
    } satisfies JsonObject;
    const source = message(1, "приложение");
    source.document = document;
    const current = message(2, "Лойлекс, продолжай по вложению");
    current.reply_to_message = source;

    database.archiveMessage(current, "bot_api");
    database.enqueue(55, current, "продолжай по вложению", null);

    const job = database.claimNext(10);
    expect(job?.attachments).toEqual([{ kind: "document", value: document }]);
    expect(job?.replyContext).toContain(
      `attachments=${JSON.stringify([{ kind: "document", value: document }])}`,
    );
    database.close();
  });

  test("reads Rich-only reply targets and archives Rich requests", () => {
    const database = setup();
    const current = message(2, "");
    delete current.text;
    current.rich_message = { blocks: [{ type: "paragraph", text: "Найди примеры LTX" }] };
    const target = botMessage(1, "");
    delete target.text;
    target.rich_message = {
      blocks: [{ type: "paragraph", text: { type: "bold", text: "LTX-2.3 FP8" } }],
    };
    current.reply_to_message = target;
    database.archiveMessage(current, "bot_api");
    database.enqueue(55, current, "Найди примеры LTX", null);
    const job = database.claimNext(10);
    expect(job?.replyContext).toContain("LTX-2.3 FP8");
    expect(
      database.readQuery("SELECT text FROM messages WHERE message_id = ?", [2], 1).rows,
    ).toEqual([{ text: "Найди примеры LTX" }]);
    database.close();
  });

  test("references an in-thread reply target by ID instead of repeating its text", () => {
    const database = setup();
    const first = message(1, "первая задача");
    database.archiveMessage(first, "bot_api");
    database.enqueue(55, first, "первая задача", null);

    const firstJob = database.claimNext(10);
    expect(firstJob).not.toBeNull();
    expect(database.complete(firstJob?.id ?? 0, 2, "thread-one")).toBe(true);
    database.recordOutboundMessage(firstJob?.id ?? 0, 2, "thread-one");

    const followUp = message(3, "продолжай");
    followUp.reply_to_message = botMessage(2, "предыдущий ответ");
    database.archiveMessage(followUp, "bot_api");
    database.enqueue(56, followUp, "продолжай", database.resumeThread(-10042, 2), "none");

    const job = database.claimNext(10);
    expect(job?.resumeThreadId).toBe("thread-one");
    expect(job?.replyToMessageId).toBe(2);
    expect(job?.replyContext).toBe(
      "Telegram reply target: #2, an earlier message of this conversation shown above.",
    );
    expect(database.complete(job?.id ?? 0, 4, "thread-one")).toBe(true);

    const ownRequest = message(5, "вернись к этому");
    ownRequest.reply_to_message = first;
    database.archiveMessage(ownRequest, "bot_api");
    database.enqueue(57, ownRequest, "вернись к этому", "thread-one");
    expect(database.claimNext(10)?.replyContext).toBe(
      "Telegram reply target: #1, an earlier message of this conversation shown above.",
    );
    database.close();
  });

  test("keeps the full reply target for a new thread or a message outside the thread", () => {
    const database = setup();
    const unrelated = botMessage(2, "чужой ответ");
    const fresh = message(3, "что это?");
    fresh.reply_to_message = unrelated;
    database.archiveMessage(fresh, "bot_api");
    database.enqueue(55, fresh, "что это?", null);
    expect(database.claimNext(10)?.replyContext).toContain(
      "Telegram reply target: #2 Loylex: чужой ответ",
    );
    database.close();
  });
});
