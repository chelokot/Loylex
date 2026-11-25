import { visibleTerminalCommand } from "../shared/terminal-command.ts";

export * from "./economy-presentation.ts";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const maxCommandActivityCharacters = 160;
const maxToolActivityCharacters = 160;
const maxWorkTitleCharacters = 80;
const workTitle = "Ход работы";

function compactActivityText(value: string, limit = 600): string {
  const compact = value.replaceAll(/\s+/g, " ").trim();
  if (compact.length <= limit) {
    return compact;
  }
  const characters = Array.from(compact);
  return characters.length <= limit
    ? compact
    : `${characters
        .slice(0, limit - 1)
        .join("")
        .trimEnd()}…`;
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

function activityEntries(status: string, includeStatus = false): ActivityEntry[] {
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
    } else if (
      kind === "reasoning" ||
      kind === "commentary" ||
      (includeStatus && kind === "status")
    ) {
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

export function workDocument(status: string, live = false): string {
  const activity = visibleActivityEntries(status, live);
  const latest = activity.at(-1);
  if (!latest) {
    return live ? workTitle : "";
  }
  const title = live
    ? compactActivityText(activityText(latest), maxWorkTitleCharacters)
    : workTitle;
  const history = activity.map(formattedActivityLine).join("\n");
  return `<details><summary>${escapeHtml(title)}</summary>\n\n${history}\n\n</details>`;
}

function visibleActivityEntries(status: string, includeStatus = false): ActivityEntry[] {
  return activityEntries(status, includeStatus).slice(-8);
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
  if (
    /\bthread(?:-store conflict\b[\s\S]*\bactive writer\b|\s+\S+\s+already has an active writer\b)/i.test(
      error,
    )
  ) {
    return "Не получилось продолжить задачу: этот Codex-тред уже занят другим запросом.\n\nДождись завершения текущей задачи и отправь запрос ещё раз — одновременно выполнять два запроса в одном треде нельзя.";
  }
  return `Не получилось завершить задачу.\n\n\`\`\`text\n${error.slice(0, 2_000)}\n\`\`\``;
}

export function failedDocument(status: string, error: string): string {
  const work = workDocument(status);
  return work ? `${work}\n\n${failureMessage(error)}` : failureMessage(error);
}

export function completedDocuments(status: string, answer: string): string[] {
  const work = workDocument(status);
  const prefix = work ? `${work}\n\n` : "";
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
    "- `лойлекс сообщение /blind` или `/blind сообщение` — новый тред без истории чата.",
    "- `/newchat сообщение` начинает новый чистый тред.",
    "- В группах используй `Лойлекс, ...` или reply на сообщение Loylex.",
    "",
    "## Команды",
    "",
    "| Команда | Что делает |",
    "| --- | --- |",
    "| `/mines` | Сапёр: новый забег; `/mines КОД` — то же поле, `/mines top КОД` — результаты. |",
    "| `/emoji_pack ИМЯ` | Выбирает эмодзипак для твоих ответов. `/emoji_pack off` выключает замену. |",
    "| `/progress` | Включает или выключает ход работы для твоих запросов во всех чатах. |",
    "| `/tasks` | Показывает последние задачи; активный draft в ЛС можно остановить кнопкой Stop. |",
    "| `/steer текст` | Передаёт уточнение в активную задачу ответом на сообщение бота или на свой запрос. |",
    "| `/stop` | Без reply останавливает вашу последнюю активную задачу в этом чате; с reply — задачу рабочего ответа. |",
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
