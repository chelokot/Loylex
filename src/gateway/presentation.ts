export const chronicleActions = [
  "🏰 Поднимаю разводной мост The Floodoncelocal Kingdom",
  "⚔️ Затачиваю королевский меч о край здравого смысла",
  "🛡️ Проверяю щиты серверной крепости на звонкость",
  "📜 Разворачиваю свиток древних протоколов",
  "🕯️ Зажигаю свечи в башне системного мудреца",
  "🐎 Седлаю самого быстрого пакетного скакуна",
  "🦅 Отправляю королевского орла за свежими вестями",
  "🔔 Бью в колокол великого деплоя",
  "👑 Полирую корону, пока механизмы набирают ход",
  "🗝️ Подбираю ключ от очередной башенной двери",
  "🏹 Натягиваю тетиву королевского файрвола",
  "🧙 Советуюсь с придворным магом по двоичным рунам",
  "🐉 Проверяю, не уснул ли дракон в серверной",
  "🍗 Подкупаю стражу жареной куриной ножкой",
  "🍺 Наполняю кубок бодрящим эликсиром",
  "🧱 Укрепляю стены The Floodoncelocal Kingdom",
  "🗺️ Сверяю карту тайных ходов королевства",
  "🧭 Кручу зачарованный компас в сторону результата",
  "🪶 Макаю гусиное перо в чернила телеметрии",
  "📯 Трублю сбор королевских процессов",
  "⚒️ Кую новый артефакт в подземной мастерской",
  "🪓 Рублю зависшие ветви древнего древа",
  "🧀 Собираю налог сыром с окрестных герцогств",
  "🐈 Допрашиваю замкового кота как главного свидетеля",
  "🦆 Назначаю боевую утку смотрителем порта",
  "🧹 Сметаю цифровую пыль с королевских архивов",
  "🚪 Смазываю петли у ворот, чтобы релиз вошёл бесшумно",
  "🪤 Расставляю ловушки для коварных багов",
  "💰 Пересчитываю золотые байты в казначействе",
  "🧪 Варю эликсир совместимости в медном котле",
  "🔮 Всматриваюсь в хрустальный шар логов",
  "⛓️ Проверяю цепи зависимостей на королевскую прочность",
  "🛶 Переправляю данные через ров без единой капли",
  "🌉 Чиню мост между башней агента и воротами gateway",
  "🔥 Раздуваю кузнечный огонь вычислений",
  "❄️ Отгоняю ледяные таймауты от крепостных стен",
  "🌩️ Прошу придворного громовержца ускорить ответ",
  "🦄 Осматриваю королевского единорога перед выездом",
  "🐺 Договариваюсь с лесными волками о безопасном маршруте",
  "🦉 Заседаю с совиным советом ночных администраторов",
  "🐌 Тороплю почтовую улитку с важнейшим донесением",
  "🐓 Сверяю время по главному замковому петуху",
  "🧌 Выдаю троллю пропуск на технический мост",
  "👻 Пересчитываю призраков в фоновых процессах",
  "🪄 Накладываю чары устойчивости на королевский стек",
  "🎺 Репетирую фанфары для успешного завершения",
  "🎭 Маскирую секретный проход от любопытных менестрелей",
  "🏆 Протираю кубок победы рукавом парадного камзола",
  "🚩 Водружаю знамя The Floodoncelocal Kingdom над башней",
  "⚜️ Скрепляю результат большой королевской печатью",
] as const;

const chronicleSeed = Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

function chronicleAction(entry: string, position: number): string {
  let hash = (2_166_136_261 ^ chronicleSeed ^ position) >>> 0;
  for (const character of entry) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return chronicleActions[hash % chronicleActions.length] ?? chronicleActions[0];
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function workDocument(status: string): string {
  const activity = activityLines(status).slice(-8);
  const history = activity.map((line) => `- ${escapeHtml(line)}`).join("\n");
  const fallback = chronicleAction("empty chronicle", 0);
  return `<details><summary>Летопись The Floodoncelocal Kingdom 🇸🇪</summary>\n\n${history || `- ${escapeHtml(fallback)}`}\n\n</details>`;
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
  return status
    .split("\n\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, position) => chronicleAction(entry, position));
}

export function failureMessage(error: string): string {
  if (/thread-store conflict\b[\s\S]*\bactive writer\b/i.test(error)) {
    return "Не получилось продолжить задачу: этот Codex-тред уже занят другим запросом.\n\nДождись завершения текущей задачи и отправь запрос ещё раз — одновременно выполнять два запроса в одном треде нельзя.";
  }
  return `Не получилось завершить задачу.\n\n\`\`\`text\n${error.slice(0, 2_000)}\n\`\`\``;
}

export function completedDocuments(status: string, answer: string): string[] {
  const kingdomBanner = [
    '<tg-emoji emoji-id="5861926791857311729">⚜️</tg-emoji>',
    '<tg-emoji emoji-id="5852921692841580896">👑</tg-emoji>',
    "The Floodoncelocal Kingdom",
  ].join(" ");
  const answerBanner = [
    '<tg-emoji emoji-id="5935947980518460257">📜</tg-emoji>',
    '<tg-emoji emoji-id="5418008880632321663">🛡️</tg-emoji>',
  ].join(" ");
  const prefix = `${workDocument(status)}\n\n${kingdomBanner}\n\n${answerBanner} `;
  const availableAnswerBytes = richMessageLimitBytes - byteLength(prefix);
  if (availableAnswerBytes <= 0) {
    return splitRichMarkdown(`${prefix}${answer}`);
  }
  const answerChunks = splitRichMarkdown(answer, availableAnswerBytes);
  return [`${prefix}${answerChunks[0] ?? ""}`, ...answerChunks.slice(1)];
}

export function helpMessage(): string {
  return [
    "**Loylex — универсальный Linux-агент**",
    "",
    "Напиши `Лойлекс, ...`, `лойликс, ...` или ответь на сообщение Loylex — запрос продолжит соответствующий Codex-тред.",
    "",
    "`/tasks` — последние задачи; `/stop` в ответ на рабочее сообщение — остановить; `/cancel_ID` — остановить задачу; `/resume_ID` — продолжить прерванную задачу, если у неё сохранился Codex-тред.",
    "",
    "Текст, изображения и файлы текущего сообщения передаются агенту через защищённый bridge. Для напоминаний и периодических действий можно попросить настроить cron/systemd timer на Linux-машине.",
  ].join("\n");
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
