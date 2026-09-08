import { afterEach, describe, expect, test } from "bun:test";
import { LoylexDatabase } from "../src/gateway/database.ts";
import {
  DISLIKE_REACTION_EMOJI,
  FEEDBACK_OPERATOR_TELEGRAM_USER_ID,
  feedbackAcknowledgement,
  feedbackPrompt,
  isOperatorDislikeReaction,
} from "../src/gateway/feedback.ts";
import type {
  TelegramMessage,
  TelegramMessageReactionUpdated,
  TelegramUpdate,
} from "../src/shared/types.ts";

const databases: LoylexDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

function reaction(
  oldReaction: TelegramMessageReactionUpdated["old_reaction"] = [],
  newReaction: TelegramMessageReactionUpdated["new_reaction"] = [
    { type: "emoji", emoji: DISLIKE_REACTION_EMOJI },
  ],
  userId = FEEDBACK_OPERATOR_TELEGRAM_USER_ID,
): TelegramMessageReactionUpdated {
  return {
    chat: { id: -10042, type: "supergroup", title: "Test" },
    message_id: 99,
    user: { id: userId, is_bot: false, first_name: "Operator" },
    date: 1_700_000_099,
    old_reaction: oldReaction,
    new_reaction: newReaction,
  };
}

function sourceMessage(): TelegramMessage {
  return {
    message_id: 1,
    date: 1_700_000_001,
    chat: { id: -10042, type: "supergroup", title: "Test" },
    from: { id: FEEDBACK_OPERATOR_TELEGRAM_USER_ID, is_bot: false, first_name: "Operator" },
    text: "Лойлекс, выполни исходную задачу",
  };
}

test("recognizes only a newly added operator dislike", () => {
  expect(isOperatorDislikeReaction(reaction())).toBe(true);
  expect(
    isOperatorDislikeReaction(reaction([{ type: "emoji", emoji: DISLIKE_REACTION_EMOJI }])),
  ).toBe(false);
  expect(isOperatorDislikeReaction(reaction([], [{ type: "emoji", emoji: "👍" }]))).toBe(false);
  expect(isOperatorDislikeReaction(reaction([], [{ type: "emoji", emoji: "👎" }], 7))).toBe(false);
});

test("builds a postmortem prompt with the previous request and answer", () => {
  const prompt = feedbackPrompt({
    jobId: 12,
    prompt: "найди причину сбоя",
    answer: "Сбой не найден",
    statusLog: "commentary: проверил логи",
    targetMessageId: 99,
  });

  expect(prompt).toContain("глубокий постмортем");
  expect(prompt).toContain("фундаментальную корневую причину");
  expect(prompt).toContain("найди причину сбоя");
  expect(prompt).toContain("Сбой не найден");
  expect(prompt).toContain("исправленно");
  expect(feedbackAcknowledgement()).toContain("повторяю задачу");
});

describe("dislike recovery jobs", () => {
  test("stores the answer, queues one recovery, and prevents recursion", () => {
    const database = new LoylexDatabase(":memory:");
    databases.push(database);
    const source = sourceMessage();
    database.archiveMessage(source, "bot_api");
    database.enqueue(55, source, "выполни исходную задачу", null);
    const sourceJob = database.claimNext(10);
    expect(sourceJob).not.toBeNull();
    expect(
      database.complete(
        sourceJob?.id ?? 0,
        99,
        "thread-source",
        undefined,
        null,
        "Первый ответ с ошибкой",
      ),
    ).toBe(true);
    expect(
      database.connection
        .query<{ answer: string | null }, [number]>("SELECT answer FROM jobs WHERE id = ?")
        .get(sourceJob?.id ?? 0),
    ).toEqual({ answer: "Первый ответ с ошибкой" });

    const firstUpdate: TelegramUpdate = { update_id: 700, message_reaction: reaction() };
    database.archiveUpdate(firstUpdate);
    const recoveryJobId = database.enqueueDislikeRecovery(firstUpdate);
    if (recoveryJobId === null) {
      throw new Error("feedback job was not queued");
    }
    expect(database.enqueueDislikeRecovery(firstUpdate)).toBeNull();

    const recoveryJob = database.claimNext(10);
    expect(recoveryJob?.id).toBe(recoveryJobId);
    expect(recoveryJob?.messageId).toBe(99);
    expect(recoveryJob?.resumeThreadId).toBe("thread-source");
    expect(recoveryJob?.prompt).toContain("Первый ответ с ошибкой");
    expect(recoveryJob?.prompt).toContain("выполни исходную задачу");

    expect(
      database.complete(
        recoveryJob?.id ?? 0,
        100,
        "thread-recovery",
        undefined,
        null,
        "Исправленный ответ",
      ),
    ).toBe(true);
    const recursiveUpdate: TelegramUpdate = {
      update_id: 701,
      message_reaction: { ...reaction(), message_id: 100 },
    };
    database.archiveUpdate(recursiveUpdate);
    expect(database.enqueueDislikeRecovery(recursiveUpdate)).toBeNull();
  });

  test("rejects a nonoperator reaction and keeps private ownership closed", () => {
    const database = new LoylexDatabase(":memory:");
    databases.push(database);
    const source: TelegramMessage = {
      ...sourceMessage(),
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Private owner" },
    };
    database.archiveMessage(source, "bot_api");
    database.enqueue(55, source, "приватная задача", null);
    const sourceJob = database.claimNext(10);
    expect(sourceJob).not.toBeNull();
    database.complete(sourceJob?.id ?? 0, 99, "thread-private", undefined, null, "Ответ");

    const nonoperator: TelegramUpdate = {
      update_id: 702,
      message_reaction: { ...reaction([], undefined, 7), chat: source.chat },
    };
    database.archiveUpdate(nonoperator);
    expect(database.enqueueDislikeRecovery(nonoperator)).toBeNull();

    const wrongOwner: TelegramUpdate = {
      update_id: 703,
      message_reaction: { ...reaction(), chat: source.chat },
    };
    database.archiveUpdate(wrongOwner);
    expect(database.enqueueDislikeRecovery(wrongOwner)).toBeNull();
  });
});
