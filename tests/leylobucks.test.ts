import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoylexDatabase } from "../src/gateway/database.ts";
import { assessLeylobucksRequest, leylobucksQuizQuestions } from "../src/gateway/leylobucks.ts";
import type { TelegramMessage } from "../src/shared/types.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(): LoylexDatabase {
  const directory = mkdtempSync(join(tmpdir(), "loylex-bucks-"));
  directories.push(directory);
  return new LoylexDatabase(join(directory, "test.sqlite"));
}

function message(id: number, text: string): TelegramMessage {
  return {
    message_id: id,
    date: 1_700_000_000 + id,
    chat: { id: -10042, type: "supergroup", title: "Test" },
    from: { id: 7, is_bot: false, first_name: "Daniel" },
    text,
  };
}

function setBalance(database: LoylexDatabase, balance: number): void {
  database.connection
    .query(`
      INSERT INTO leylobucks_accounts (
        user_id, balance, catgirl_messages, next_quiz_size, quiz_attempt, updated_at
      ) VALUES (7, ?, 0, 5, 0, ?)
      ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at
    `)
    .run(balance, Date.now());
}

function correctAnswer(database: LoylexDatabase): string {
  const row = database.connection
    .query<{ questions_json: string; question_index: number }, [number]>(`
      SELECT questions_json, question_index
      FROM leylobucks_quiz_sessions
      WHERE user_id = ?
    `)
    .get(7);
  if (!row) {
    throw new Error("quiz session is missing");
  }
  const questions = JSON.parse(row.questions_json) as Array<{ correctIndex: number }>;
  return String((questions[row.question_index]?.correctIndex ?? 0) + 1);
}

describe("Loylebucks assessment", () => {
  test("keeps the score in range and rewards a concrete request more than a blank one", () => {
    const good = assessLeylobucksRequest(
      "Проверь этот баг, объясни причину и предложи конкретный исправленный вариант с тестом.",
    );
    const bad = assessLeylobucksRequest("");

    expect(good.qualityScore).toBeGreaterThan(bad.qualityScore);
    expect(good.delta).toBeGreaterThan(0);
    expect(bad.delta).toBeLessThan(0);
    expect(good.qualityScore).toBeGreaterThanOrEqual(0);
    expect(good.qualityScore).toBeLessThanOrEqual(100);
    expect(good.delta).toBeGreaterThanOrEqual(-100);
    expect(good.delta).toBeLessThanOrEqual(100);
  });
});

describe("Loylebucks quiz question bank", () => {
  test("contains 60 general and 60 technical questions with balanced technical difficulty", () => {
    const difficultyCounts = { easy: 0, medium: 0, hard: 0 };
    const technicalDifficultyCounts = { easy: 0, medium: 0, hard: 0 };
    const categoryCounts = new Map<string, number>();
    const ids = new Set<string>();

    for (const question of leylobucksQuizQuestions) {
      difficultyCounts[question.difficulty] += 1;
      if (question.category === "технологии") {
        technicalDifficultyCounts[question.difficulty] += 1;
      }
      categoryCounts.set(question.category, (categoryCounts.get(question.category) ?? 0) + 1);
      ids.add(question.id);
      expect(question.options).toHaveLength(4);
      expect(question.correctIndex).toBeGreaterThanOrEqual(0);
      expect(question.correctIndex).toBeLessThan(question.options.length);
    }

    expect(leylobucksQuizQuestions).toHaveLength(120);
    expect(ids).toHaveLength(120);
    expect(difficultyCounts).toEqual({ easy: 40, medium: 40, hard: 40 });
    expect(technicalDifficultyCounts).toEqual({ easy: 20, medium: 20, hard: 20 });
    expect(categoryCounts.get("технологии")).toBe(60);
    expect(categoryCounts.size).toBe(9);
    expect([...categoryCounts.values()].sort((left, right) => left - right)).toEqual([
      7, 7, 7, 7, 8, 8, 8, 8, 60,
    ]);
  });
});

describe("LoylexDatabase Loylebucks", () => {
  test("charges a request once and exposes its economy to the worker", () => {
    const database = setup();
    const incoming = message(1, "проверь этот баг и предложи конкретный фикс с тестом");
    database.archiveMessage(incoming, "bot_api");

    const first = database.enqueueWithLeylobucks(
      1,
      incoming,
      "проверь запрос",
      incoming.text ?? "",
      null,
    );
    const duplicate = database.enqueueWithLeylobucks(
      1,
      incoming,
      "проверь запрос",
      incoming.text ?? "",
      null,
    );

    expect(first.kind).toBe("queued");
    expect(duplicate).toEqual({ kind: "duplicate" });
    expect(
      database.connection
        .query<{ count: number }, []>("SELECT count(*) AS count FROM leylobucks_transactions")
        .get()?.count,
    ).toBe(1);

    const job = database.claimNext(10);
    expect(job?.leylobucks).toMatchObject({
      qualityScore: expect.any(Number),
      delta: expect.any(Number),
      balance: expect.any(Number),
      catgirlMode: false,
    });
    database.close();
  });

  test("plain enqueue leaves the economy untouched for the disabled mode", () => {
    const database = setup();
    const incoming = message(4, "обычный запрос без лейлобаксов");
    database.archiveMessage(incoming, "bot_api");

    database.enqueue(4, incoming, incoming.text ?? "", null);
    const job = database.claimNext(10, null, () => false);

    expect(job?.leylobucks).toBeUndefined();
    expect(database.leylobucksStatus(7)).toMatchObject({
      balance: 0,
      catgirlMessages: 0,
      quiz: null,
    });
    expect(
      database.connection
        .query<{ count: number }, []>("SELECT count(*) AS count FROM leylobucks_transactions")
        .get()?.count,
    ).toBe(0);
    database.close();
  });

  test("applies the runtime mode independently to users sharing a chat", () => {
    const database = setup();
    const firstMessage = message(5, "запрос первого пользователя");
    const secondMessage = {
      ...message(6, "запрос второго пользователя"),
      from: { id: 8, is_bot: false, first_name: "Sergey" },
    };
    database.archiveMessage(firstMessage, "bot_api");
    database.archiveMessage(secondMessage, "bot_api");
    database.enqueueWithLeylobucks(5, firstMessage, firstMessage.text ?? "", "", null);
    database.enqueueWithLeylobucks(6, secondMessage, secondMessage.text ?? "", "", null);

    const seenUserIds: Array<number | null> = [];
    const isEnabled = (userId: number | null): boolean => {
      seenUserIds.push(userId);
      return userId !== 7;
    };
    const firstJob = database.claimNext(10, null, isEnabled);
    const secondJob = database.claimNext(10, null, isEnabled);

    expect(seenUserIds).toEqual([7, 8]);
    expect(firstJob?.leylobucks).toBeUndefined();
    expect(secondJob?.leylobucks).toMatchObject({ balance: expect.any(Number) });
    database.close();
  });

  test("allows rewards above 500 and sells the three requested packages", () => {
    const database = setup();
    setBalance(database, 490);
    const incoming = message(
      2,
      "Проверь, пожалуйста, почему этот тест падает и предложи исправление с объяснением.",
    );
    database.archiveMessage(incoming, "bot_api");
    const admission = database.enqueueWithLeylobucks(
      2,
      incoming,
      incoming.text ?? "",
      incoming.text ?? "",
      null,
    );

    expect(admission.kind).toBe("queued");
    const balanceAfterReward = database.leylobucksStatus(7).balance;
    expect(balanceAfterReward).toBeGreaterThan(500);

    const purchase = database.purchaseLeylobucks(7, 500);
    expect(purchase.status).toBe("purchased");
    expect(purchase.statusView.balance).toBe(balanceAfterReward - 500);
    expect(purchase.statusView.catgirlMessages).toBe(10);

    const modeMessage = message(
      3,
      "объясни, пожалуйста, почему этот результат важен и что проверить дальше",
    );
    database.archiveMessage(modeMessage, "bot_api");
    database.enqueueWithLeylobucks(
      3,
      modeMessage,
      modeMessage.text ?? "",
      modeMessage.text ?? "",
      null,
    );
    database.claimNext(10);
    const modeJob = database.claimNext(10);
    expect(modeJob?.leylobucks).toMatchObject({ catgirlMode: true, catgirlMessagesLeft: 9 });

    expect(database.purchaseLeylobucks(7, 250).status).toBe("insufficient");
    database.close();
  });

  test("allows a large test bump and audits it", () => {
    const database = setup();
    setBalance(database, 86);

    const result = database.testBumpLeylobucks(7, 1_000_000);

    expect(result.statusView.balance).toBe(1_000_086);
    expect(
      database.connection
        .query<
          { delta: number; balance_after: number; reason: string; metadata_json: string },
          []
        >(`
          SELECT delta, balance_after, reason, metadata_json
          FROM leylobucks_transactions
          WHERE reason = 'test_bump'
        `)
        .get(),
    ).toEqual({
      delta: 1_000_000,
      balance_after: 1_000_086,
      reason: "test_bump",
      metadata_json: JSON.stringify({ testOnly: true }),
    });

    expect(() => database.testBumpLeylobucks(7, Number.MAX_SAFE_INTEGER)).toThrow(
      "safe integer range",
    );
    expect(() => database.testBumpLeylobucks(7, 0)).toThrow("positive safe integer");
    database.close();
  });

  test("rejects a reward that would exceed the safe integer range", () => {
    const database = setup();
    const incoming = message(
      5,
      "Проверь, пожалуйста, почему этот тест падает и предложи исправление с объяснением.",
    );
    const assessment = assessLeylobucksRequest(incoming.text ?? "");
    expect(assessment.delta).toBeGreaterThan(0);
    const balance = Number.MAX_SAFE_INTEGER - assessment.delta + 1;
    setBalance(database, balance);
    database.archiveMessage(incoming, "bot_api");

    expect(() =>
      database.enqueueWithLeylobucks(5, incoming, incoming.text ?? "", incoming.text ?? "", null),
    ).toThrow("safe integer range");
    expect(database.leylobucksStatus(7).balance).toBe(balance);
    expect(database.connection.query("SELECT id FROM jobs").all()).toEqual([]);
    database.close();
  });

  test("passes with four of five answers and forgives the debt", () => {
    const database = setup();
    setBalance(database, -40);
    const started = database.quizLeylobucks(7);
    expect(started.kind).toBe("started");
    expect(started.questionCount).toBe(5);

    let finished = false;
    let wrongAnswerIndex: number | null = null;
    for (let index = 0; index < 5; index += 1) {
      const correct = Number(correctAnswer(database));
      const answer = index === 0 ? String((correct % 4) + 1) : String(correct);
      if (index === 0) {
        wrongAnswerIndex = Number(answer) - 1;
      }
      const action = database.quizLeylobucks(7, answer);
      if (index < 4) {
        expect(action.kind).toBe("next");
        expect(action.review).toBeNull();
      } else {
        expect(action.kind).toBe("passed");
        expect(action.correctCount).toBe(4);
        expect(action.review).toHaveLength(5);
        expect(action.review?.[0]).toMatchObject({ answerIndex: wrongAnswerIndex, correct: false });
        expect(action.review?.slice(1).every((item) => item.correct)).toBe(true);
        finished = true;
      }
    }
    expect(finished).toBe(true);
    expect(database.leylobucksStatus(7)).toMatchObject({ balance: 0, nextQuizSize: 5, quiz: null });
    database.close();
  });

  test("can be started with a positive balance and preserves it after passing", () => {
    const database = setup();
    setBalance(database, 120);
    const started = database.quizLeylobucks(7);
    expect(started.kind).toBe("started");
    expect(started.questionCount).toBe(5);

    for (let index = 0; index < 5; index += 1) {
      const correct = correctAnswer(database);
      const action = database.quizLeylobucks(7, correct);
      if (index < 4) {
        expect(action.kind).toBe("next");
      } else {
        expect(action.kind).toBe("passed");
        expect(action.correctCount).toBe(5);
      }
    }

    expect(database.leylobucksStatus(7)).toMatchObject({
      balance: 120,
      nextQuizSize: 5,
      quiz: null,
    });
    expect(
      database.connection
        .query<{ delta: number; balance_after: number }, [number]>(`
          SELECT delta, balance_after
          FROM leylobucks_transactions
          WHERE user_id = ? AND reason = 'quiz_passed'
        `)
        .get(7),
    ).toEqual({ delta: 0, balance_after: 120 });
    database.close();
  });

  test("increases the next quiz after a failed attempt", () => {
    const database = setup();
    setBalance(database, -1);
    expect(database.quizLeylobucks(7).kind).toBe("started");

    for (let index = 0; index < 5; index += 1) {
      const correct = Number(correctAnswer(database));
      const wrong = ((correct + 1) % 4) + 1;
      database.quizLeylobucks(7, String(wrong));
    }

    expect(database.leylobucksStatus(7)).toMatchObject({
      balance: -1,
      nextQuizSize: 6,
      quiz: null,
    });
    expect(database.quizLeylobucks(7).questionCount).toBe(6);
    database.close();
  });
});
