import { visibleTerminalCommand } from "../shared/terminal-command.ts";
import type {
  LeylobucksJobEconomy,
  LeylobucksPurchaseResult,
  LeylobucksQuizAction,
  LeylobucksQuizReview,
  LeylobucksStatus,
  LeylobucksTestBumpResult,
} from "./database.ts";
import { leylobucksPackages } from "./leylobucks.ts";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const maxCommandActivityCharacters = 160;
const maxToolActivityCharacters = 160;

function compactActivityText(value: string, limit = 600): string {
  const compact = value.replaceAll(/\s+/g, " ").trim();
  if (compact.length <= limit) {
    return compact;
  }
  return `${compact.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function commandActivity(command: string): string {
  const visible = compactActivityText(command, maxCommandActivityCharacters);
  return visible ? `Run '${visible}'` : "Run 'terminal command'";
}

function stripToolCallMarker(text: string): string {
  const marker = " [tool-call:";
  const markerStart = text.lastIndexOf(marker);
  return markerStart >= 0 && text.endsWith("]") ? text.slice(0, markerStart).trim() : text.trim();
}

function toolActivity(text: string): string {
  const visible = compactActivityText(stripToolCallMarker(text), maxToolActivityCharacters);
  if (!visible) {
    return "Used 'unknown'";
  }
  if (/^(Searched for|Used) '/.test(visible)) {
    return visible;
  }
  return `Used '${visible}'`;
}

type ActivityEntry = {
  kind: "command" | "tool" | "narrative";
  text: string;
};

function activityEntries(status: string): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  const add = (entry: ActivityEntry): void => {
    const previous = entries.at(-1);
    if (
      entry.kind === "narrative" &&
      previous?.kind === "narrative" &&
      previous.text === entry.text
    ) {
      return;
    }
    entries.push(entry);
  };

  for (const entry of status.split("\n\n")) {
    const separator = entry.indexOf(":");
    const kind = separator === -1 ? "status" : entry.slice(0, separator);
    const text = (separator === -1 ? entry : entry.slice(separator + 1)).trim();
    if (kind === "command") {
      const compact = compactActivityText(
        visibleTerminalCommand(text),
        maxCommandActivityCharacters,
      );
      add({ kind: "command", text: compact || "terminal command" });
    } else if (kind === "tool") {
      const visible = toolActivity(text);
      if (visible) {
        add({ kind: "tool", text: visible });
      }
    } else if (kind === "reasoning" || kind === "commentary") {
      const visible = compactActivityText(text);
      if (visible) {
        add({ kind: "narrative", text: visible });
      }
    }
  }
  return entries;
}

function activityText(entry: ActivityEntry): string {
  if (entry.kind === "command") {
    return commandActivity(entry.text);
  }
  return entry.text;
}

function inlineCode(value: string): string {
  return `\`${escapeHtml(value).replaceAll("`", "\\`")}\``;
}

function unquoteActivityText(value: string): string {
  return value.replaceAll("\\'", "'");
}

function formattedActivityLine(entry: ActivityEntry): string {
  if (entry.kind === "command") {
    return `- **Run** ${inlineCode(entry.text)}`;
  }
  if (entry.kind === "tool") {
    const match = entry.text.match(/^(Searched for|Used) '([\s\S]*)'$/);
    if (match) {
      return `- **${escapeHtml(match[1] ?? "Used")}** ${inlineCode(unquoteActivityText(match[2] ?? ""))}`;
    }
  }
  return `- ${escapeHtml(entry.text)}`;
}

export function workDocument(status: string): string {
  const activity = visibleActivityEntries(status);
  const history = activity.map(formattedActivityLine).join("\n");
  return `<details><summary>Ход работы</summary>\n\n${history || "- Готово"}\n\n</details>`;
}

function visibleActivityEntries(status: string): ActivityEntry[] {
  return activityEntries(status).slice(-8);
}

export const richMessageLimitBytes = 30_000;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function takeRichChunk(value: string, maxBytes: number): [string, string] {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    bytes += characterBytes;
    end += character.length;
  }
  if (end === 0) {
    throw new Error("Rich message chunk limit is too small for one character");
  }
  const candidate = value.slice(0, end);
  const newline = candidate.lastIndexOf("\n");
  // Prefer paragraph/line boundaries while keeping very long lines deliverable.
  const boundary = newline >= Math.floor(candidate.length / 2) ? newline + 1 : end;
  return [value.slice(0, boundary), value.slice(boundary)];
}

export function splitRichMarkdown(markdown: string, maxBytes = richMessageLimitBytes): string[] {
  if (maxBytes <= 0) {
    throw new Error("Rich message chunk limit must be positive");
  }
  if (byteLength(markdown) <= maxBytes) {
    return [markdown];
  }
  const chunks: string[] = [];
  let remaining = markdown;
  while (remaining.length > 0) {
    const [chunk, rest] = takeRichChunk(remaining, maxBytes);
    chunks.push(chunk);
    remaining = rest;
  }
  return chunks;
}

export function activityLines(status: string): string[] {
  return visibleActivityEntries(status).map(activityText);
}

export function failureMessage(error: string): string {
  if (/thread-store conflict\b[\s\S]*\bactive writer\b/i.test(error)) {
    return "Не получилось продолжить задачу: этот Codex-тред уже занят другим запросом.\n\nДождись завершения текущей задачи и отправь запрос ещё раз — одновременно выполнять два запроса в одном треде нельзя.";
  }
  return `Не получилось завершить задачу.\n\n\`\`\`text\n${error.slice(0, 2_000)}\n\`\`\``;
}

export function failedDocument(status: string, error: string): string {
  return `${workDocument(status)}\n\n${failureMessage(error)}`;
}

export function completedDocuments(status: string, answer: string): string[] {
  const prefix = `${workDocument(status)}\n\n`;
  const availableAnswerBytes = richMessageLimitBytes - byteLength(prefix);
  if (availableAnswerBytes <= 0) {
    return [prefix, ...splitRichMarkdown(answer)];
  }
  const answerChunks = splitRichMarkdown(answer, availableAnswerBytes);
  return answerChunks.map((chunk, index) => {
    const first = index === 0 ? prefix : "";
    return `${first}${chunk}`;
  });
}

export function helpMessage(leylobucksEnabled = true): string {
  const lines = [
    "# 🤖 Loylex — универсальный Linux-агент",
    "",
    "## Как общаться",
    "",
    "- В личке обычное сообщение продолжает последний Codex-тред без reply.",
    "- Ответ на старое сообщение переключает запрос в тред этого сообщения.",
    "- `/newchat сообщение` начинает новый чистый тред.",
    "- В группах используй `Лойлекс, ...` или reply на сообщение Loylex.",
    "",
    "## Команды",
    "",
    "| Команда | Что делает |",
    "| --- | --- |",
    "| `/tasks` | Показывает последние задачи; активный draft в ЛС можно остановить кнопкой Stop. |",
    "| `/stop` | Останавливает задачу в группе reply-сообщением на рабочий ответ. |",
    "| `/cancel_ID` | Останавливает задачу по ID сообщения. |",
    "| `/resume_ID` | Продолжает прерванную задачу, если сохранился Codex-тред. |",
  ];
  if (leylobucksEnabled) {
    lines.push(
      "",
      "## 💰 Лейлобаксы",
      "",
      "- `/bucks` — баланс и магазин.",
      "- `/bucks buy 100` — купить 1 сообщение в режиме милой аниме-кошкодевочки-жены.",
      "- `/bucks on` и `/bucks off` — включить или выключить режим только для себя.",
      "- `/quiz` — пройти викторину в любое время.",
    );
  }
  lines.push(
    "",
    "## Ввод",
    "",
    "Текст, изображения и файлы текущего сообщения передаются агенту через защищённый bridge.",
    "Для напоминаний и периодических действий можно попросить настроить cron/systemd timer на Linux-машине.",
  );
  return lines.join("\n");
}

export function leylobucksModeMessage(enabled: boolean): string {
  if (enabled) {
    return [
      "# ✅ Режим лейлобаксов включён",
      "",
      "Теперь для тебя доступны баланс, покупки, викторины и начисления.",
      "",
      "> Балансы, покупки, долги и история в базе данных не изменены.",
    ].join("\n");
  }
  return [
    "# ⏸️ Режим лейлобаксов выключен",
    "",
    "Новые запросы обрабатываются как раньше — без проверок долгов, начислений и списаний, информации о лейлобаксах в prompt и футере ответа.",
    "",
    "> Сохранённые балансы и история в базе данных не изменены.",
    "",
    "_Переключатель хранится только в памяти gateway; после его перезапуска режим снова включится._",
  ].join("\n");
}

function signed(value: number): string {
  return value > 0 ? `+${formatInteger(value)}` : formatInteger(value);
}

function formatInteger(value: number): string {
  const sign = value < 0 ? "-" : "";
  const [integerPart, fractionPart] = String(Math.abs(value)).split(".");
  const grouped = (integerPart ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${grouped}${fractionPart ? `.${fractionPart}` : ""}`;
}

function messageCountLabel(count: number): string {
  const moduloTen = count % 10;
  const moduloHundred = count % 100;
  if (moduloTen === 1 && moduloHundred !== 11) {
    return "сообщение";
  }
  if (moduloTen >= 2 && moduloTen <= 4 && (moduloHundred < 10 || moduloHundred >= 20)) {
    return "сообщения";
  }
  return "сообщений";
}

function accountTable(status: LeylobucksStatus): string {
  return [
    "| Показатель | Значение |",
    "| --- | ---: |",
    `| Баланс | **${formatInteger(status.balance)}** |`,
    `| Сообщений в режиме 🐾 | **${formatInteger(status.catgirlMessages)}** |`,
  ].join("\n");
}

function shopTable(): string {
  const packages = leylobucksPackages.map(
    ({ cost, messages }) =>
      `| \`/bucks buy ${cost}\` | **${formatInteger(cost)}** | ${formatInteger(messages)} ${messageCountLabel(messages)} |`,
  );
  return [
    "## 🛍 Магазин",
    "",
    "| Команда | Цена | Результат |",
    "| --- | ---: | ---: |",
    ...packages,
    "",
    "_Сообщения расходуются в режиме милой аниме-кошкодевочки-жены._",
  ].join("\n");
}

function leylobucksCommandsDocument(): string {
  return [
    "<details><summary>Команды</summary>",
    "",
    "- `/bucks` — показать баланс и магазин",
    "- `/bucks buy 100`, `/bucks buy 250`, `/bucks buy 500` — купить пакет",
    "- `/bucks on` / `/bucks off` — включить или выключить режим только для себя",
    "- `/quiz` — начать или продолжить викторину",
    "",
    "</details>",
  ].join("\n");
}

function quizAnswerButtons(options: readonly string[]): string {
  const buttons = options.slice(0, 4).map((option, index) => {
    const letter = String.fromCharCode(65 + index);
    const label = escapeHtml(option.replace(/\s+/gu, " ").trim());
    return `<tg-button type="callback_data" style="primary" data="quiz:${letter}">${label}</tg-button>`;
  });
  return buttons
    .map((button) => `<tg-button-row align="center">${button}</tg-button-row>`)
    .join("\n");
}

function quizQuestionMessage(
  question: NonNullable<LeylobucksStatus["quiz"]>["question"],
  questionIndex: number,
  questionCount: number,
  correctCount: number,
): string {
  return [
    `Вопрос ${questionIndex + 1}/${questionCount} · ${question.category} · Счёт: ${correctCount}/${questionCount}`,
    "",
    `> ${question.prompt}`,
    "",
    quizAnswerButtons(question.options),
  ].join("\n");
}

function quizReviewMessage(review: readonly LeylobucksQuizReview[]): string {
  const lines = ["## Разбор ответов", ""];
  review.forEach((item, index) => {
    const answer =
      item.answerIndex === null
        ? "ответ не сохранён"
        : (item.question.options[item.answerIndex] ?? "неизвестный вариант");
    const correctAnswer =
      item.question.options[item.question.correctIndex] ?? "неизвестный вариант";
    lines.push(
      `${item.correct ? "✅" : "❌"} **${index + 1}.** ${item.question.prompt.replace(/\s+/gu, " ").trim()}`,
      `   **Твой ответ:** ${answer}`,
    );
    if (!item.correct) {
      lines.push(`   **Правильный ответ:** ${correctAnswer}`);
    }
    if (index < review.length - 1) {
      lines.push("");
    }
  });
  return lines.join("\n");
}

export function leylobucksStatusMessage(status: LeylobucksStatus): string {
  const lines = ["# 💰 Лейлобаксы", "", accountTable(status), "", shopTable()];
  if (status.balance < 0) {
    lines.push(
      "",
      "## ⚠️ Баланс в минусе",
      "",
      "Обычные запросы заблокированы, пока баланс отрицательный.",
      `Нужно пройти **${formatInteger(status.nextQuizSize)}** вопросов и ответить правильно минимум на **${formatInteger(Math.max(1, status.nextQuizSize - 1))}**.`,
      "",
      "Запусти `/quiz`, чтобы начать викторину.",
    );
  } else if (status.quiz) {
    lines.push(
      "",
      "## 🧠 Текущая викторина",
      "",
      quizQuestionMessage(
        status.quiz.question,
        status.quiz.questionIndex,
        status.quiz.questionCount,
        status.quiz.correctCount,
      ),
    );
  } else {
    lines.push("", "> 💡 Викторину можно проходить в любое время — запусти `/quiz`.");
  }
  lines.push("", leylobucksCommandsDocument());
  return lines.join("\n");
}

export function leylobucksPurchaseMessage(result: LeylobucksPurchaseResult): string {
  if (result.status === "invalid_package") {
    return [
      "# 🛍 Магазин лейлобаксов",
      "",
      "> ❌ Такой пакет не найден.",
      "",
      shopTable(),
      "",
      "## Текущий счёт",
      "",
      accountTable(result.statusView),
    ].join("\n");
  }
  if (result.status === "in_debt") {
    return [
      "# ⚠️ Покупка недоступна",
      "",
      `Покупки заблокированы при отрицательном балансе: **${formatInteger(result.statusView.balance)}**.`,
      "",
      `Пройди викторину из **${formatInteger(result.statusView.nextQuizSize)}** вопросов и ответь правильно минимум на **${formatInteger(Math.max(1, result.statusView.nextQuizSize - 1))}**.`,
      "",
      "## Текущий счёт",
      "",
      accountTable(result.statusView),
      "",
      shopTable(),
    ].join("\n");
  }
  if (result.status === "insufficient" && result.package) {
    const missing = result.package.cost - result.statusView.balance;
    return [
      "# 🛒 Недостаточно лейлобаксов",
      "",
      `Для пакета за **${formatInteger(result.package.cost)}** не хватает **${formatInteger(missing)}** лейлобаксов.`,
      "",
      "## Текущий счёт",
      "",
      accountTable(result.statusView),
      "",
      shopTable(),
    ].join("\n");
  }
  if (result.package) {
    return [
      "# ✅ Покупка оформлена",
      "",
      "| Показатель | Значение |",
      "| --- | ---: |",
      `| Пакет | \`/bucks buy ${result.package.cost}\` |`,
      `| Списано | **${formatInteger(result.package.cost)} лейлобаксов** |`,
      `| Добавлено | **${formatInteger(result.package.messages)} ${messageCountLabel(result.package.messages)}** |`,
      "",
      "## После покупки",
      "",
      accountTable(result.statusView),
      "",
      "🐾 Сообщения будут использоваться в режиме милой аниме-кошкодевочки-жены.",
    ].join("\n");
  }
  return leylobucksStatusMessage(result.statusView);
}

export function leylobucksInvalidCommandMessage(): string {
  return [
    "# 🛍 Магазин лейлобаксов",
    "",
    "> ❌ Не понял, какой пакет купить.",
    "",
    shopTable(),
    "",
    "Пример: `/bucks buy 100`.",
  ].join("\n");
}

export function leylobucksTestBumpMessage(result: LeylobucksTestBumpResult): string {
  return [
    "# 🧪 Тестовое начисление",
    "",
    `> Начислено: **+${formatInteger(result.amount)} лейлобаксов**.`,
    "",
    "## Текущий счёт",
    "",
    accountTable(result.statusView),
  ].join("\n");
}

export function leylobucksTestBumpInvalidMessage(): string {
  return [
    "# 🧪 Тестовое начисление",
    "",
    "> ❌ Не удалось распознать сумму.",
    "",
    "Использование: `/test_bump AMOUNT`",
    "Пример: `/test_bump 1000000`",
    "_AMOUNT должен быть положительным целым числом._",
  ].join("\n");
}

export function leylobucksQuizMessage(action: LeylobucksQuizAction): string {
  if (action.kind === "invalid_answer") {
    const lines = ["> ⚠️ Выбери один из вариантов."];
    if (action.question) {
      lines.push(
        "",
        quizQuestionMessage(
          action.question,
          action.status.quiz?.questionIndex ?? 0,
          action.questionCount ?? action.status.quiz?.questionCount ?? 5,
          action.correctCount ?? action.status.quiz?.correctCount ?? 0,
        ),
      );
    }
    return lines.join("\n");
  }
  if (action.kind === "passed") {
    const questionCount = action.questionCount ?? 0;
    const correctCount = action.correctCount ?? 0;
    const lines = [
      "# 🎉 Викторина пройдена!",
      "",
      "| Показатель | Результат |",
      "| --- | ---: |",
      `| Правильные ответы | **${correctCount}/${questionCount}** |`,
      `| Баланс после викторины | **${formatInteger(action.status.balance)}** |`,
    ];
    if (action.review && action.review.length > 0) {
      lines.push("", quizReviewMessage(action.review));
    }
    lines.push("", "> Отлично! Можно продолжать общаться и зарабатывать лейлобаксы.");
    return lines.join("\n");
  }
  if (action.kind === "failed") {
    const questionCount = action.questionCount ?? 0;
    const correctCount = action.correctCount ?? 0;
    const nextQuizSize = action.nextQuizSize ?? questionCount + 1;
    const lines = [
      "# ❌ Викторина не пройдена",
      "",
      "| Показатель | Результат |",
      "| --- | ---: |",
      `| Правильные ответы | **${correctCount}/${questionCount}** |`,
      `| Баланс | **${formatInteger(action.status.balance)}** |`,
    ];
    if (action.review && action.review.length > 0) {
      lines.push("", quizReviewMessage(action.review));
    }
    lines.push(
      "",
      `> В следующий раз: **${formatInteger(nextQuizSize)}** вопросов; проходной балл — **${formatInteger(Math.max(1, nextQuizSize - 1))}/${formatInteger(nextQuizSize)}**.`,
      "",
      "Запусти `/quiz`, чтобы попробовать снова.",
    );
    return lines.join("\n");
  }
  if (action.question) {
    const quiz = action.status.quiz;
    const question = quizQuestionMessage(
      action.question,
      quiz?.questionIndex ?? 0,
      action.questionCount ?? quiz?.questionCount ?? 5,
      action.correctCount ?? quiz?.correctCount ?? 0,
    );
    if (action.kind !== "next") {
      return question;
    }
    return `${action.correct ? "✅ Верно." : "❌ Неверно."}\n\n${question}`;
  }
  return leylobucksStatusMessage(action.status);
}

export function leylobucksBlockedMessage(status: LeylobucksStatus): string {
  return [
    "# ⛔ Запрос заблокирован",
    "",
    `Баланс: **${formatInteger(status.balance)}**`,
    "",
    "> Пока баланс отрицательный, Loylex принимает только команду `/quiz`.",
    "",
    "## Как продолжить",
    "",
    `Пройди **${formatInteger(status.nextQuizSize)}** вопросов и ответь правильно минимум на **${formatInteger(Math.max(1, status.nextQuizSize - 1))}**.`,
    "",
    "Запусти `/quiz`, чтобы начать или продолжить викторину.",
  ].join("\n");
}

export function leylobucksFooter(economy: LeylobucksJobEconomy): string {
  const lines = [
    "---",
    `<details><summary>💰 Лейлобаксы · ${signed(economy.delta)} · баланс ${formatInteger(economy.balance)}</summary>`,
    "",
    "| Показатель | Значение |",
    "| --- | ---: |",
    `| Изменение | **${signed(economy.delta)} лейлобаксов** |`,
    `| Оценка запроса | **${formatInteger(economy.qualityScore)}/100** |`,
    `| Баланс | **${formatInteger(economy.balance)}** |`,
  ];
  if (economy.catgirlMode) {
    lines.push(
      `| Режим кошкодевочки-жены | использован |`,
      `| Осталось сообщений | **${formatInteger(economy.catgirlMessagesLeft)}** |`,
    );
  }
  if (economy.balance < 0) {
    lines.push("", "> ⚠️ Следующий обычный запрос будет заблокирован до прохождения `/quiz`.");
  }
  lines.push("", "</details>");
  return lines.join("\n");
}

export function resumeUnavailableMessage(): string {
  return "Эту задачу пока нельзя продолжить: для неё не сохранился Codex-тред. Запусти её заново новым запросом.";
}

function taskCountLabel(count: number): string {
  const moduloTen = count % 10;
  const moduloHundred = count % 100;
  if (moduloTen === 1 && moduloHundred !== 11) {
    return "задача";
  }
  if (moduloTen >= 2 && moduloTen <= 4 && (moduloHundred < 10 || moduloHundred >= 20)) {
    return "задачи";
  }
  return "задач";
}

export function stopResultMessage(cancelledCount: number): string {
  return cancelledCount > 0
    ? `⏹️ Остановлено: ${cancelledCount} ${taskCountLabel(cancelledCount)}.`
    : "Активных задач для остановки нет.";
}
