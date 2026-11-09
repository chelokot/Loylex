import { afterEach, describe, expect, test } from "bun:test";
import type { TelegramMessage } from "../src/shared/types.ts";
import type { AgentTokenUsage } from "../src/shared/usage.ts";

import { message, privateMessage, removeDatabases, setup } from "./fixtures/database.ts";

afterEach(removeDatabases);

describe("LoylexDatabase", () => {
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

  test("cancels a private job addressed by its draft ID", () => {
    const database = setup();
    const incoming = privateMessage(1, "долгая задача");
    database.enqueue(55, incoming, "долгая задача", null);

    const running = database.claimNext(10);
    expect(running).not.toBeNull();
    expect(database.cancelJobsForDraft(42, running?.id ?? 0)).toEqual([running?.id ?? 0]);
    expect(database.isJobCancelled(running?.id ?? 0)).toBe(true);
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
        thinkingMessageId: 11,
        canResume: false,
      },
    ]);
    database.close();
  });

  test("aggregates token usage by user, Telegram thread, Codex thread, and day", () => {
    const database = setup();
    const usageOne: AgentTokenUsage = {
      inputTokens: 100,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 2,
      outputTokens: 20,
      reasoningOutputTokens: 15,
      totalTokens: 120,
    };
    const usageTwo: AgentTokenUsage = {
      inputTokens: 50,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 3,
      outputTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens: 60,
    };
    const first = message(1, "первая задача");
    first.message_thread_id = 101;
    database.archiveMessage(first, "bot_api");
    database.enqueue(1, first, "первая задача", null);
    const firstJob = database.claimNext(10);
    expect(firstJob).not.toBeNull();
    database.complete(firstJob?.id ?? 0, 11, "thread-usage", undefined, usageOne);

    const second: TelegramMessage = {
      ...message(2, "вторая задача"),
      message_thread_id: 101,
      from: { id: 8, is_bot: false, first_name: "Artem", username: "exposedcat" },
    };
    database.archiveMessage(second, "bot_api");
    database.enqueue(2, second, "вторая задача", "thread-usage");
    const secondJob = database.claimNext(10);
    expect(secondJob).not.toBeNull();
    database.complete(secondJob?.id ?? 0, 12, "thread-usage", undefined, usageTwo);

    const report = database.usageReport();
    expect(report.summary).toMatchObject({
      jobs: 2,
      meteredJobs: 2,
      unmeteredJobs: 0,
      inputTokens: 150,
      cachedInputTokens: 90,
      nonCachedInputTokens: 60,
      cacheWriteInputTokens: 5,
      outputTokens: 30,
      reasoningOutputTokens: 20,
      totalTokens: 180,
    });
    expect(report.byUser.map((row) => row.userId)).toEqual([7, 8]);
    expect(report.byTelegramThread).toHaveLength(1);
    expect(report.byTelegramThread[0]).toMatchObject({
      chatId: -10042,
      messageThreadId: 101,
      inputTokens: 150,
    });
    expect(report.byCodexThread).toHaveLength(1);
    expect(report.byCodexThread[0]).toMatchObject({
      threadId: "thread-usage",
      inputTokens: 150,
    });
    expect(report.byCodexThread[0]?.users.map((row) => row.userId)).toEqual([7, 8]);
    expect(report.byDay).toHaveLength(1);
    expect(report.byDay[0]).toMatchObject({ inputTokens: 150, outputTokens: 30 });
    database.close();
  });

  test("records usage on a running job and keeps it when it fails", () => {
    const database = setup();
    const incoming = message(1, "задача с ошибкой");
    database.archiveMessage(incoming, "bot_api");
    database.enqueue(1, incoming, "задача с ошибкой", null);
    const job = database.claimNext(10);
    expect(job).not.toBeNull();
    const usage: AgentTokenUsage = {
      inputTokens: 22,
      cachedInputTokens: 11,
      cacheWriteInputTokens: 0,
      outputTokens: 4,
      reasoningOutputTokens: 3,
      totalTokens: 26,
    };
    expect(database.recordUsage(job?.id ?? 0, usage, undefined, "thread-failed")).toBe(true);
    database.fail(job?.id ?? 0, "ошибка", undefined, "thread-failed", usage);

    const report = database.usageReport();
    expect(report.summary).toMatchObject({ jobs: 1, meteredJobs: 1, inputTokens: 22 });
    expect(report.byCodexThread[0]?.threadId).toBe("thread-failed");
    database.close();
  });
});

test("steering selects stop targets without cancelling, isolates workers, and deduplicates input", () => {
  const database = setup();
  database.registerWorker("steer-worker");
  database.enqueue(55, message(1, "long task"), "long task", null);
  const job = database.claimNext(10, "steer-worker");
  const id = job?.id ?? 0;
  database.setThinkingMessage(id, 10);
  database.appendStatus(id, "working", "thread-steer", "steer-worker");
  database.recordOutboundMessage(id, 11, "thread-steer");
  expect(database.queueSteer(-10043, 10, 12, 8, "wrong chat")).toEqual([]);
  expect(database.queueSteer(-10042, 11, 12, 8, "new input")).toEqual([id]);
  expect(database.queueSteer(-10042, 11, 12, 8, "new input")).toEqual([id]);
  expect(database.isJobCancelled(id)).toBe(false);
  expect(database.pendingSteers(id, "wrong-worker")).toEqual([]);
  const entries = database.pendingSteers(id, "steer-worker");
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ messageId: 12, userId: 8, prompt: "new input" });
  const steerId = entries[0]?.id ?? 0;
  expect(database.finishSteer(id, steerId, "wrong-worker", true)).toBeNull();
  expect(database.finishSteer(id, steerId, "steer-worker", true)).toBe(12);
  expect(database.finishSteer(id, steerId, "steer-worker", true)).toBeNull();
  expect(database.pendingSteers(id, "steer-worker")).toEqual([]);
  database.queueSteer(-10042, 10, 13, 8, "too late");
  database.complete(id, 20, "thread-steer", "steer-worker");
  expect(database.failPendingSteers(id)).toEqual([13]);
  expect(database.failPendingSteers(id)).toEqual([]);
  expect(database.queueSteer(-10042, 11, 14, 8, "finished")).toEqual([]);
  database.close();
});
