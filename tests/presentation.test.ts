import { describe, expect, test } from "bun:test";
import {
  activityLines,
  chronicleActions,
  completedDocuments,
  failureMessage,
  stopResultMessage,
  workDocument,
} from "../src/gateway/presentation.ts";

describe("activityLines", () => {
  test("replaces every internal event with a medieval chronicle action", () => {
    const status = [
      "command: /bin/bash -lc 'find skills -maxdepth 2 -name SKILL.md -print'",
      "status: Команда завершена с кодом 0",
      "command: /bin/bash -lc 'free -h; df -h /; uptime'",
    ].join("\n\n");

    const actions = activityLines(status);
    const availableActions = new Set<string>(chronicleActions);
    expect(actions).toHaveLength(3);
    expect(actions.every((action) => availableActions.has(action))).toBe(true);
    expect(actions.join("\n")).not.toContain("find skills");
    expect(actions.join("\n")).not.toContain("Команда завершена");
    expect(actions.join("\n")).not.toContain("free -h");
  });

  test("provides exactly 50 distinct chronicle actions", () => {
    expect(chronicleActions).toHaveLength(50);
    expect(new Set(chronicleActions).size).toBe(50);
  });

  test("uses the kingdom chronicle title without exposing commentary", () => {
    const document = workDocument("commentary: Секретный реальный шаг");

    expect(document).toContain(
      "<details><summary>Летопись The Floodoncelocal Kingdom 🇸🇪</summary>",
    );
    expect(document).not.toContain("Секретный реальный шаг");
  });

  test("adds the exact custom emoji template before the final answer", () => {
    const document = completedDocuments("status: Готово", "Финальный ответ")[0] ?? "";

    expect(document).toContain(
      '<tg-emoji emoji-id="5861926791857311729">⚜️</tg-emoji> <tg-emoji emoji-id="5852921692841580896">👑</tg-emoji> The Floodoncelocal Kingdom\n\n',
    );
    expect(document).toContain(
      '<tg-emoji emoji-id="5935947980518460257">📜</tg-emoji> <tg-emoji emoji-id="5418008880632321663">🛡️</tg-emoji> Финальный ответ',
    );
    expect(document).not.toContain(
      '<tg-emoji emoji-id="5418008880632321663">🛡️</tg-emoji>\nФинальный ответ',
    );
  });

  test("describes the result of a stop command", () => {
    expect(stopResultMessage(1)).toBe("⏹️ Остановлено: 1 задача.");
    expect(stopResultMessage(2)).toBe("⏹️ Остановлено: 2 задачи.");
    expect(stopResultMessage(5)).toBe("⏹️ Остановлено: 5 задач.");
    expect(stopResultMessage(0)).toBe("Активных задач для остановки нет.");
  });
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
