import { describe, expect, test } from "bun:test";
import {
  activityLines,
  completedDocuments,
  failedDocument,
  failureMessage,
  helpMessage,
  leylobucksModeMessage,
  leylobucksQuizMessage,
  leylobucksTestBumpMessage,
  stopResultMessage,
  toolsDocument,
  toolUsages,
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

    expect(activityLines(status)).toEqual(["Подбираю нужные навыки", "Проверяю ресурсы сервера"]);
  });

  test("prefers Codex commentary over command classifications", () => {
    const status = [
      "command: uname -a",
      "commentary: Сначала проверю окружение, затем сопоставлю результаты.",
      "command: git status --short",
    ].join("\n\n");

    expect(activityLines(status)).toEqual([
      "Сначала проверю окружение, затем сопоставлю результаты.",
    ]);
  });

  test("deduplicates command fallback globally without command-specific placeholders", () => {
    const status = [
      "command: uname -a",
      "command: git status --short",
      "command: whoami",
      "command: git diff --stat",
    ].join("\n\n");

    expect(activityLines(status)).toEqual(["Работаю в терминале"]);
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
    ).toEqual([
      "<details><summary>WORK</summary>\n\n- Готово\n\n</details>\n\nОтвет пользователю\n\n<details><summary>Использованные инструменты</summary>\n\n- Инструменты не использовались\n\n</details>",
    ]);
    expect(
      completedDocuments("commentary: Проверяю код\n\nstatus: Готово", "Ответ пользователю").map(
        normalizeWorkSummary,
      ),
    ).toEqual([
      "<details><summary>WORK</summary>\n\n- Проверяю код\n\n</details>\n\nОтвет пользователю\n\n<details><summary>Использованные инструменты</summary>\n\n- Инструменты не использовались\n\n</details>",
    ]);
  });

  test("keeps useful multi-step work history", () => {
    expect(
      completedDocuments(
        "commentary: Проверяю код\n\ncommentary: Запускаю тесты\n\nstatus: Готово",
        "Ответ пользователю",
      ).map(normalizeWorkSummary),
    ).toEqual([
      "<details><summary>WORK</summary>\n\n- Проверяю код\n- Запускаю тесты\n\n</details>\n\nОтвет пользователю\n\n<details><summary>Использованные инструменты</summary>\n\n- Инструменты не использовались\n\n</details>",
    ]);
  });
});

test("counts tools from status events and renders a collapsed list", () => {
  const status = [
    "tool: exec [tool-call:one]",
    "tool: web.run [tool-call:two]",
    "tool: exec [tool-call:three]",
    "status: Готово",
  ].join("\n\n");

  expect(toolUsages(status)).toEqual([
    { name: "exec", count: 2 },
    { name: "web.run", count: 1 },
  ]);
  expect(toolsDocument(status)).toBe(
    "<details><summary>Использованные инструменты</summary>\n\n- exec — 2 раза\n- web.run — 1 раз\n\n</details>",
  );
});

test("puts the tools dropdown on the last chunk of a long answer", () => {
  const status = "tool: exec [tool-call:one]";
  const documents = completedDocuments(status, "ответ ".repeat(6_000));
  const firstDocument = normalizeWorkSummary(documents[0] ?? "");
  const lastDocument = documents.at(-1) ?? "";

  expect(documents.length).toBeGreaterThan(1);
  expect(firstDocument).toContain("<summary>WORK</summary>");
  expect(firstDocument).not.toContain("Использованные инструменты");
  expect(lastDocument).toContain("<summary>Использованные инструменты</summary>");
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

test("bolds a random option in a Loylebucks quiz question", () => {
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
    correct: null,
    questionCount: 4,
    correctCount: 0,
    nextQuizSize: null,
  } as const;

  const firstOption = leylobucksQuizMessage(action, () => 0);
  expect(firstOption).toContain("**A) Первый**\nB) Второй\nC) Третий\nD) Четвёртый");
  expect(firstOption).not.toContain("**B) Второй**");

  const lastOption = leylobucksQuizMessage(action, () => 0.99);
  expect(lastOption).toContain("A) Первый\nB) Второй\nC) Третий\n**D) Четвёртый**");
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

  expect(message).toContain("Тестовое начисление: **+1000000**");
  expect(message).toContain("Баланс: **1000000**");
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
