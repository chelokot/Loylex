import type {
  LeylobucksJobEconomy,
  LeylobucksPurchaseResult,
  LeylobucksQuizAction,
  LeylobucksStatus,
  LeylobucksTestBumpResult,
} from "./database.ts";

function commandActivity(command: string): string {
  const normalized = command.toLowerCase();
  if (normalized.includes("find skills") || normalized.includes("-name skill.md")) {
    return "Подбираю нужные навыки";
  }
  if (normalized.includes("skill.md")) {
    return "Читаю рабочие инструкции";
  }
  if (
    normalized.includes("free -") ||
    normalized.includes("df -") ||
    normalized.includes("/proc/cpuinfo") ||
    normalized.includes("/proc/loadavg") ||
    normalized.includes("uptime")
  ) {
    return "Проверяю ресурсы сервера";
  }
  if (normalized.includes("systemctl") || normalized.includes("ps -")) {
    return "Проверяю процессы и сервисы";
  }
  if (normalized.includes("loylex status")) {
    return "Проверяю Telegram и очередь задач";
  }
  if (normalized.includes("curl ") || normalized.includes("wget ")) {
    return "Получаю данные из сети";
  }
  return "Работаю в терминале";
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function workDocument(status: string): string {
  const activity = visibleActivity(status);
  const history = activity.map((line) => `- ${escapeHtml(line)}`).join("\n");
  return `<details><summary>Ход работы</summary>\n\n${history || "- Готово"}\n\n</details>`;
}

export type ToolUsage = {
  name: string;
  count: number;
};

function storedToolName(text: string): string {
  const marker = " [tool-call:";
  const markerStart = text.lastIndexOf(marker);
  return markerStart >= 0 && text.endsWith("]") ? text.slice(0, markerStart).trim() : text.trim();
}

export function toolUsages(status: string): ToolUsage[] {
  const counts = new Map<string, number>();
  for (const entry of status.split("\n\n")) {
    const separator = entry.indexOf(":");
    if (separator === -1 || entry.slice(0, separator) !== "tool") {
      continue;
    }
    const name = storedToolName(entry.slice(separator + 1));
    if (name) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts].map(([name, count]) => ({ name, count }));
}

function toolUseCountLabel(count: number): string {
  const moduloTen = count % 10;
  const moduloHundred = count % 100;
  if (moduloTen === 1 && moduloHundred !== 11) {
    return "раз";
  }
  if (moduloTen >= 2 && moduloTen <= 4 && (moduloHundred < 10 || moduloHundred >= 20)) {
    return "раза";
  }
  return "раз";
}

export function toolsDocument(status: string): string {
  const usages = toolUsages(status);
  const history = usages
    .map(({ name, count }) => `- ${escapeHtml(name)} — ${count} ${toolUseCountLabel(count)}`)
    .join("\n");
  return `<details><summary>Использованные инструменты</summary>\n\n${history || "- Инструменты не использовались"}\n\n</details>`;
}

function visibleActivity(status: string): string[] {
  return activityLines(status).slice(-8);
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
  const fallback: string[] = [];
  const narrative: string[] = [];
  for (const entry of status.split("\n\n")) {
    const separator = entry.indexOf(":");
    const kind = separator === -1 ? "status" : entry.slice(0, separator);
    const text = (separator === -1 ? entry : entry.slice(separator + 1)).trim();
    if (kind === "command") {
      const visible = commandActivity(text);
      if (!fallback.includes(visible)) {
        fallback.push(visible);
      }
    } else if (kind === "reasoning" || kind === "commentary") {
      const visible = text.slice(0, 600);
      if (visible && narrative.at(-1) !== visible) {
        narrative.push(visible);
      }
    }
  }
  return narrative.length > 0 ? narrative : fallback;
}

export function failureMessage(error: string): string {
  if (/thread-store conflict\b[\s\S]*\bactive writer\b/i.test(error)) {
    return "Не получилось продолжить задачу: этот Codex-тред уже занят другим запросом.\n\nДождись завершения текущей задачи и отправь запрос ещё раз — одновременно выполнять два запроса в одном треде нельзя.";
  }
  return `Не получилось завершить задачу.\n\n\`\`\`text\n${error.slice(0, 2_000)}\n\`\`\``;
}

export function failedDocument(status: string, error: string): string {
  return `${workDocument(status)}\n\n${failureMessage(error)}\n\n${toolsDocument(status)}`;
}

export function completedDocuments(status: string, answer: string): string[] {
  const prefix = `${workDocument(status)}\n\n`;
  const suffix = `\n\n${toolsDocument(status)}`;
  const availableAnswerBytes = richMessageLimitBytes - byteLength(prefix) - byteLength(suffix);
  if (availableAnswerBytes <= 0) {
    return [prefix, ...splitRichMarkdown(answer), suffix.slice(2)];
  }
  const answerChunks = splitRichMarkdown(answer, availableAnswerBytes);
  return answerChunks.map((chunk, index) => {
    const first = index === 0 ? prefix : "";
    const last = index === answerChunks.length - 1 ? suffix : "";
    return `${first}${chunk}${last}`;
  });
}

export function helpMessage(leylobucksEnabled = true): string {
  const lines = [
    "**Loylex — универсальный Linux-агент**",
    "",
    "В личке можно писать обычным сообщением — оно продолжит последний Codex-тред без reply. Ответ на старое сообщение переключит запрос в тред этого сообщения. `/newchat сообщение` начнёт новый чистый тред. В группах по-прежнему используй `Лойлекс, ...` или reply на сообщение Loylex.",
    "",
    "`/tasks` — последние задачи; в ЛС активный draft можно остановить кнопкой Stop, а в группах `/stop` отправляется reply на рабочее сообщение; `/cancel_ID` — остановить задачу; `/resume_ID` — продолжить прерванную задачу, если у неё сохранился Codex-тред.",
    "",
    "Текст, изображения и файлы текущего сообщения передаются агенту через защищённый bridge. Для напоминаний и периодических действий можно попросить настроить cron/systemd timer на Linux-машине.",
  ];
  if (leylobucksEnabled) {
    lines.splice(
      5,
      0,
      "`/bucks` — баланс и магазин лейлобаксов; `/bucks buy 100` — купить 1 сообщение в режиме милой аниме-кошкодевочки-жены; `/bucks on` и `/bucks off` — включить или выключить режим для этого чата. `/quiz` — пройти викторину в любое время.",
    );
  }
  return lines.join("\n");
}

export function leylobucksModeMessage(enabled: boolean): string {
  if (enabled) {
    return [
      "✅ Режим лейлобаксов включён для этого чата.",
      "",
      "Балансы, покупки, долги и история в базе данных не изменены.",
    ].join("\n");
  }
  return [
    "⏸️ Режим лейлобаксов выключен для этого чата.",
    "",
    "Новые запросы обрабатываются как раньше: без проверок долгов, начислений и списаний, информации о лейлобаксах в prompt и футере ответа.",
    "Сохранённые балансы и история в базе данных не изменены.",
    "",
    "Переключатель хранится только в памяти gateway; после его перезапуска режим снова включится.",
  ].join("\n");
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function balanceLabel(balance: number): string {
  return String(balance);
}

function quizQuestionMessage(
  question: NonNullable<LeylobucksStatus["quiz"]>["question"],
  questionIndex: number,
  questionCount: number,
  correctCount: number,
): string {
  const options = question.options
    .map((option, index) => {
      const answer = `${String.fromCharCode(65 + index)}) ${option}`;
      return index === question.correctIndex ? `**${answer}**` : answer;
    })
    .join("\n");
  return [
    `**Вопрос ${questionIndex + 1}/${questionCount} — ${question.category}**`,
    "",
    question.prompt,
    "",
    options,
    "",
    `Правильных ответов: ${correctCount}. Ответь командой \`/quiz A\` (или B/C/D). Нужно правильно ответить минимум на ${Math.max(1, questionCount - 1)} из ${questionCount}.`,
  ].join("\n");
}

export function leylobucksStatusMessage(status: LeylobucksStatus): string {
  const lines = [
    "**Лейлобаксы**",
    "",
    `Баланс: **${balanceLabel(status.balance)}**`,
    `Сообщений в режиме кошкодевочки-жены: **${status.catgirlMessages}**`,
    "",
    "Магазин:",
    "- 100 — 1 сообщение",
    "- 250 — 3 сообщения",
    "- 500 — 10 сообщений",
  ];
  if (status.balance < 0) {
    lines.push(
      "",
      "Баланс отрицательный: обычные запросы заблокированы. Запусти `/quiz`, чтобы пройти викторину.",
      `Следующая викторина: ${status.nextQuizSize} вопросов; нужно минимум ${Math.max(1, status.nextQuizSize - 1)} правильных.`,
    );
  } else if (status.quiz) {
    lines.push(
      "",
      "Викторина уже начата:",
      quizQuestionMessage(
        status.quiz.question,
        status.quiz.questionIndex,
        status.quiz.questionCount,
        status.quiz.correctCount,
      ),
    );
  } else {
    lines.push(
      "",
      "Команды: `/bucks`, `/bucks buy 100`, `/bucks buy 250`, `/bucks buy 500`, `/quiz`.",
    );
  }
  return lines.join("\n");
}

export function leylobucksPurchaseMessage(result: LeylobucksPurchaseResult): string {
  if (result.status === "invalid_package") {
    return "Такого товара нет. Можно купить пакет за 100, 250 или 500 лейлобаксов.";
  }
  if (result.status === "in_debt") {
    return `${leylobucksStatusMessage(result.statusView)}\n\nПокупки недоступны, пока баланс отрицательный.`;
  }
  if (result.status === "insufficient" && result.package) {
    const missing = result.package.cost - result.statusView.balance;
    return `${leylobucksStatusMessage(result.statusView)}\n\nНе хватает ${missing} лейлобаксов для этого пакета.`;
  }
  if (result.package) {
    return [
      `✅ Куплено: ${result.package.messages} ${result.package.messages === 1 ? "сообщение" : "сообщений"} в режиме милой аниме-кошкодевочки-жены за ${result.package.cost}.`,
      "",
      leylobucksStatusMessage(result.statusView),
    ].join("\n");
  }
  return leylobucksStatusMessage(result.statusView);
}

export function leylobucksInvalidCommandMessage(): string {
  return "Не понял покупку. Используй `/bucks`, `/bucks buy 100`, `/bucks buy 250` или `/bucks buy 500`.";
}

export function leylobucksTestBumpMessage(result: LeylobucksTestBumpResult): string {
  return [
    `🧪 Тестовое начисление: **+${result.amount}** лейлобаксов.`,
    "",
    leylobucksStatusMessage(result.statusView),
  ].join("\n");
}

export function leylobucksTestBumpInvalidMessage(): string {
  return "Используй `/test_bump AMOUNT`, где AMOUNT — положительное целое число (например, `/test_bump 1000000`).";
}

export function leylobucksQuizMessage(action: LeylobucksQuizAction): string {
  if (action.kind === "invalid_answer") {
    return `Не понял ответ. Напиши букву A, B, C или D командой \`/quiz A\`.\n\n${action.question ? quizQuestionMessage(action.question, action.status.quiz?.questionIndex ?? 0, action.questionCount ?? 5, action.correctCount ?? 0) : ""}`;
  }
  if (action.kind === "passed") {
    return `🎉 Викторина пройдена: ${action.correctCount}/${action.questionCount}. Баланс после викторины: **${action.status.balance}**. Можно продолжать общаться и зарабатывать лейлобаксы.`;
  }
  if (action.kind === "failed") {
    return `❌ Викторина не пройдена: ${action.correctCount}/${action.questionCount}. Баланс остаётся **${action.status.balance}**. В следующий раз будет ${action.nextQuizSize} вопросов; запусти \`/quiz\` ещё раз.`;
  }
  if (action.question) {
    const prefix =
      action.kind === "next"
        ? action.correct
          ? "✅ Верно."
          : "❌ Неверно."
        : action.kind === "in_progress"
          ? "Викторина продолжается."
          : "Викторина начата.";
    const quiz = action.status.quiz;
    return `${prefix}\n\n${quizQuestionMessage(action.question, quiz?.questionIndex ?? 0, action.questionCount ?? quiz?.questionCount ?? 5, action.correctCount ?? quiz?.correctCount ?? 0)}`;
  }
  return leylobucksStatusMessage(action.status);
}

export function leylobucksBlockedMessage(status: LeylobucksStatus): string {
  return [
    `Запрос не выполнен: баланс **${status.balance}**.`,
    "",
    "Пока баланс отрицательный, Loylex принимает только команду `/quiz`.",
    `Нужно пройти ${status.nextQuizSize} вопросов и ответить правильно минимум на ${Math.max(1, status.nextQuizSize - 1)}.`,
  ].join("\n");
}

export function leylobucksFooter(economy: LeylobucksJobEconomy): string {
  const lines = [
    "---",
    `💰 Лейлобаксы: **${signed(economy.delta)}** (оценка запроса ${economy.qualityScore}/100). Баланс: **${economy.balance}**.`,
  ];
  if (economy.catgirlMode) {
    lines.push(
      `🐾 Режим кошкодевочки-жены использован. Осталось сообщений: **${economy.catgirlMessagesLeft}**.`,
    );
  }
  if (economy.balance < 0) {
    lines.push(
      "⚠️ Баланс отрицательный: следующий обычный запрос будет заблокирован до прохождения `/quiz`.",
    );
  }
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
