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
  if (economy.assessmentReason) {
    lines.push("", `<p>${escapeHtml(economy.assessmentReason)}</p>`);
  }
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
    ? `**Работа остановлена**\n\nОтменено: ${cancelledCount} ${taskCountLabel(cancelledCount)}.`
    : "Сейчас ничего не выполняется.";
}
