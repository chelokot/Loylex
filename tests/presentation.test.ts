import { describe, expect, test } from "bun:test";
import {
  activityLines,
  completedDocuments,
  failedDocument,
  failureMessage,
  helpMessage,
  leylobucksBlockedMessage,
  leylobucksFooter,
  leylobucksModeMessage,
  leylobucksPurchaseMessage,
  leylobucksQuizMessage,
  leylobucksStatusMessage,
  leylobucksTestBumpMessage,
  stopResultMessage,
  workDocument,
} from "../src/gateway/presentation.ts";

function normalizeWorkSummary(value: string): string {
  return value.replace(/<summary>.*<\/summary>/, "<summary>WORK</summary>");
}

describe("activityLines", () => {
  test("turns shell events into concise user-facing activity", () => {
    const status = [
      "command: /bin/bash -lc 'find skills -maxdepth 2 -name SKILL.md -print'",
      "status: Команда завершена с кодом 0",
      "command: /bin/bash -lc 'free -h; df -h /; uptime'",
    ].join("\n\n");

    const expectedRun = (command: string) =>
      `Run '${command.replaceAll("'", String.fromCharCode(92, 39))}'`;
    expect(activityLines(status)).toEqual([
      expectedRun("/bin/bash -lc 'find skills -maxdepth 2 -name SKILL.md -print'"),
      expectedRun("/bin/bash -lc 'free -h; df -h /; uptime'"),
    ]);
  });

  test("prefers concrete commands when commentary is also present", () => {
    const status = [
      "command: uname -a",
      "commentary: Сначала проверю окружение, затем сопоставлю результаты.",
      "command: git status --short",
    ].join("\n\n");

    expect(activityLines(status)).toEqual(["Run 'uname -a'", "Run 'git status --short'"]);
  });

  test("keeps each concrete command instead of generic command placeholders", () => {
    const status = [
      "command: uname -a",
      "command: git status --short",
      "command: whoami",
      "command: git diff --stat",
    ].join("\n\n");

    expect(activityLines(status)).toEqual([
      "Run 'uname -a'",
      "Run 'git status --short'",
      "Run 'whoami'",
      "Run 'git diff --stat'",
    ]);
  });

  test("describes the result of a stop command", () => {
    expect(stopResultMessage(1)).toBe("⏹️ Остановлено: 1 задача.");
    expect(stopResultMessage(2)).toBe("⏹️ Остановлено: 2 задачи.");
    expect(stopResultMessage(5)).toBe("⏹️ Остановлено: 5 задач.");
    expect(stopResultMessage(0)).toBe("Активных задач для остановки нет.");
  });
});

describe("completedDocuments", () => {
  test("preserves answer emoji without converting them to a pack", () => {
    const [document] = completedDocuments("status: Готово", "да 😂");
    expect(document).toContain("да 😂");
    expect(document).not.toContain("tg-emoji");
  });

  test("keeps work history even when it contains at most one visible item", () => {
    expect(
      completedDocuments("status: Готово", "Ответ пользователю").map(normalizeWorkSummary),
    ).toEqual(["<details><summary>WORK</summary>\n\n- Готово\n\n</details>\n\nОтвет пользователю"]);
    expect(
      completedDocuments("commentary: Проверяю код\n\nstatus: Готово", "Ответ пользователю").map(
        normalizeWorkSummary,
      ),
    ).toEqual([
      "<details><summary>WORK</summary>\n\n- Проверяю код\n\n</details>\n\nОтвет пользователю",
    ]);
  });

  test("keeps useful multi-step work history", () => {
    expect(
      completedDocuments(
        "commentary: Проверяю код\n\ncommentary: Запускаю тесты\n\nstatus: Готово",
        "Ответ пользователю",
      ).map(normalizeWorkSummary),
    ).toEqual([
      "<details><summary>WORK</summary>\n\n- Проверяю код\n- Запускаю тесты\n\n</details>\n\nОтвет пользователю",
    ]);
  });
});

test("renders concrete tool activity in the work dropdown", () => {
  const status = [
    "tool: Searched for 'latest Codex release' [tool-call:one]",
    "tool: Used 'image_gen' [tool-call:two]",
    "command: rg -n presentation src tests",
    "status: Готово",
  ].join("\n\n");

  expect(workDocument(status)).toBe(
    "<details><summary>Ход работы</summary>\n\n- Searched for 'latest Codex release'\n- Used 'image_gen'\n- Run 'rg -n presentation src tests'\n\n</details>",
  );
  expect(workDocument(status)).not.toContain("Использованные инструменты");
});

test("keeps the only work dropdown on the first chunk of a long answer", () => {
  const status = "tool: Used 'new_tool' [tool-call:one]";
  const documents = completedDocuments(status, "ответ ".repeat(6_000));
  const firstDocument = normalizeWorkSummary(documents[0] ?? "");
  const lastDocument = documents.at(-1) ?? "";

  expect(documents.length).toBeGreaterThan(1);
  expect(firstDocument).toContain("<summary>WORK</summary>");
  expect(firstDocument).toContain("Used 'new_tool'");
  expect(documents.join("\n")).not.toContain("Использованные инструменты");
  expect(lastDocument).not.toContain("<details>");
});

test("keeps the work summary stable across repeated renders", () => {
  const expected = "<details><summary>Ход работы</summary>\n\n- Готово\n\n</details>";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    expect(workDocument("status: Готово")).toBe(expected);
  }
});

test("hides Loylebucks help in the disabled runtime mode", () => {
  expect(helpMessage(false)).not.toContain("/bucks");
  expect(helpMessage(true)).toContain("/bucks");
  expect(leylobucksModeMessage(false)).toContain("Сохранённые балансы и история");
});

test("renders a compact Loylebucks quiz with answer buttons", () => {
  const action = {
    kind: "started",
    status: {
      userId: 7,
      balance: -1,
      catgirlMessages: 0,
      nextQuizSize: 5,
      quiz: null,
    },
    question: {
      category: "тест",
      prompt: "Какой вариант правильный?",
      options: ["Первый", "Второй", "Третий", "Четвёртый"],
      correctIndex: 1,
    },
    review: null,
    correct: null,
    questionCount: 4,
    correctCount: 0,
    nextQuizSize: null,
  } as const;

  const message = leylobucksQuizMessage(action);
  expect(message).toContain("Вопрос 1/4 · тест · Счёт: 0/4");
  expect(message).toContain(
    '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="quiz:A">Первый</tg-button></tg-button-row>\n<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="quiz:B">Второй</tg-button></tg-button-row>',
  );
  expect(message).toContain(
    '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="quiz:C">Третий</tg-button></tg-button-row>\n<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="quiz:D">Четвёртый</tg-button></tg-button-row>',
  );
  expect(message).toContain("> Какой вариант правильный?");
  expect(message).not.toContain("# 🧠 Викторина");
  expect(message).not.toContain("Викторина продолжается");
  expect(message).not.toContain("| Вариант | Ответ |");
  expect(message).not.toContain("Порог");
  expect(message).not.toContain("**Ответ:**");
});

test("renders every final quiz answer with a clear correctness marker", () => {
  const message = leylobucksQuizMessage({
    kind: "failed",
    status: {
      userId: 7,
      balance: -1,
      catgirlMessages: 0,
      nextQuizSize: 6,
      quiz: null,
    },
    question: null,
    review: [
      {
        question: {
          category: "тест",
          prompt: "Первый вопрос?",
          options: ["Верный ответ", "Другой ответ"],
          correctIndex: 0,
        },
        answerIndex: 0,
        correct: true,
      },
      {
        question: {
          category: "тест",
          prompt: "Второй вопрос?",
          options: ["Неверный ответ", "Верный ответ"],
          correctIndex: 1,
        },
        answerIndex: 0,
        correct: false,
      },
    ],
    correct: false,
    questionCount: 2,
    correctCount: 1,
    nextQuizSize: 3,
  });

  expect(message).toContain("## Разбор ответов");
  expect(message).toContain("✅ **1.** Первый вопрос?");
  expect(message).toContain("**Твой ответ:** Верный ответ");
  expect(message).toContain("❌ **2.** Второй вопрос?");
  expect(message).toContain("**Твой ответ:** Неверный ответ");
  expect(message).toContain("**Правильный ответ:** Верный ответ");
});

test("renders a test bump together with the resulting large balance", () => {
  const message = leylobucksTestBumpMessage({
    amount: 1_000_000,
    statusView: {
      userId: 7,
      balance: 1_000_000,
      catgirlMessages: 0,
      nextQuizSize: 5,
      quiz: null,
    },
  });

  expect(message).toContain("Начислено: **+1 000 000 лейлобаксов**");
  expect(message).toContain("| Баланс | **1 000 000** |");
});

test("renders the Loylebucks status as compact rich sections", () => {
  const message = leylobucksStatusMessage({
    userId: 7,
    balance: 1_000_000,
    catgirlMessages: 10,
    nextQuizSize: 5,
    quiz: null,
  });

  expect(message).toContain("# 💰 Лейлобаксы");
  expect(message).toContain("| Баланс | **1 000 000** |");
  expect(message).toContain("| `/bucks buy 500` | **500** | 10 сообщений |");
  expect(message).toContain("<details><summary>Команды</summary>");
  expect(message).not.toContain("Магазин:\n- 100");
});

test("keeps purchase, blocked, and earned-bucks messages scannable", () => {
  const status = {
    userId: 7,
    balance: -40,
    catgirlMessages: 0,
    nextQuizSize: 5,
    quiz: null,
  } as const;

  const purchase = leylobucksPurchaseMessage({
    status: "purchased",
    package: { cost: 500, messages: 10 },
    statusView: { ...status, balance: 120, catgirlMessages: 10 },
  });
  expect(purchase).toContain("# ✅ Покупка оформлена");
  expect(purchase).toContain("| Добавлено | **10 сообщений** |");
  expect(purchase).toContain("## После покупки");
  expect(purchase).not.toContain("# 💰 Лейлобаксы");

  const blocked = leylobucksBlockedMessage(status);
  expect(blocked).toContain("# ⛔ Запрос заблокирован");
  expect(blocked).toContain("## Как продолжить");
  expect(blocked).toContain("**4**");

  const footer = leylobucksFooter({
    qualityScore: 82,
    delta: 64,
    balance: 1_000_064,
    catgirlMode: true,
    catgirlMessagesLeft: 9,
  });
  expect(footer).toContain("<details><summary>💰 Лейлобаксы · +64 · баланс 1 000 064</summary>");
  expect(footer).toContain("| Оценка запроса | **82/100** |");
  expect(footer).toContain("| Осталось сообщений | **9** |");
});

test("explains a busy Codex thread without exposing CLI diagnostics", () => {
  const message = failureMessage(
    "Codex exited with 1: thread-store conflict: thread abc already has an active writer",
  );

  expect(message).toBe(
    "Не получилось продолжить задачу: этот Codex-тред уже занят другим запросом.\n\nДождись завершения текущей задачи и отправь запрос ещё раз — одновременно выполнять два запроса в одном треде нельзя.",
  );
  expect(message).not.toContain("thread-store conflict");
  expect(message).not.toContain("active writer");
});

test("keeps the work history in a failure document", () => {
  const message = failedDocument(
    "commentary: Проверяю архив",
    "TypeError: The socket connection was closed unexpectedly",
  );

  expect(message).toContain("<summary>Ход работы</summary>");
  expect(message).toContain("- Проверяю архив");
  expect(message).toContain("Не получилось завершить задачу.");
  expect(message).toContain("The socket connection was closed unexpectedly");
});
