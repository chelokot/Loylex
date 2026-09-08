import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoylexDatabase } from "../src/gateway/database.ts";
import { assessLeylobucksRequest } from "../src/gateway/leylobucks.ts";
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

  test("caps rewards at 500 and sells the three requested packages", () => {
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
    expect(database.leylobucksStatus(7).balance).toBeLessThanOrEqual(500);
    expect(database.leylobucksStatus(7).balance).toBe(500);

    const purchase = database.purchaseLeylobucks(7, 500);
    expect(purchase.status).toBe("purchased");
    expect(purchase.statusView.balance).toBe(0);
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

  test("passes with four of five answers and forgives the debt", () => {
    const database = setup();
    setBalance(database, -40);
    const started = database.quizLeylobucks(7);
    expect(started.kind).toBe("started");
    expect(started.questionCount).toBe(5);

    for (let index = 0; index < 5; index += 1) {
      const correct = Number(correctAnswer(database));
      const answer = index === 0 ? String((correct % 4) + 1) : String(correct);
      const action = database.quizLeylobucks(7, answer);
      if (index < 4) {
        expect(action.kind).toBe("next");
      } else {
        expect(action.kind).toBe("passed");
        expect(action.correctCount).toBe(4);
      }
    }
    expect(database.leylobucksStatus(7)).toMatchObject({ balance: 0, nextQuizSize: 5, quiz: null });
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
