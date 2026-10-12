import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { JsonObject, TelegramMessage, TelegramUpdate } from "../shared/types.ts";
import type { TelegramClient } from "./telegram.ts";

const size = 6;
const start = 14;
export function neighbors(cell: number): number[] {
  return Array.from({ length: 36 }, (_, i) => i).filter(
    (i) =>
      i !== cell &&
      Math.abs((i % size) - (cell % size)) <= 1 &&
      Math.abs(Math.floor(i / size) - Math.floor(cell / size)) <= 1,
  );
}
export function minefield(seed: string): Set<number> {
  const safe = new Set([start, ...neighbors(start)]);
  return new Set(
    Array.from({ length: 36 }, (_, i) => i)
      .filter((i) => !safe.has(i))
      .sort((a, b) =>
        createHash("sha256")
          .update(`${seed}:${a}`)
          .digest("hex")
          .localeCompare(createHash("sha256").update(`${seed}:${b}`).digest("hex")),
      )
      .slice(0, 6),
  );
}
export function reveal(mines: Set<number>, opened: number[], cell: number): number[] {
  const result = new Set(opened);
  const pending = [cell];
  while (pending.length) {
    const current = pending.pop();
    if (current === undefined || result.has(current) || mines.has(current)) continue;
    result.add(current);
    if (!neighbors(current).some((i) => mines.has(i))) pending.push(...neighbors(current));
  }
  return [...result];
}
type Player = {
  chat: number;
  seed: string;
  user: number;
  name: string;
  opened: string;
  started: number | null;
  ended: number | null;
  lost: number;
  message: number | null;
};

export class MinesGame {
  readonly db: Database;
  constructor(
    path: string,
    readonly telegram: TelegramClient,
  ) {
    this.db = new Database(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS mines_players (
      chat INTEGER NOT NULL, seed TEXT NOT NULL, user INTEGER NOT NULL, name TEXT NOT NULL,
      opened TEXT NOT NULL DEFAULT '[]', started INTEGER, ended INTEGER, lost INTEGER NOT NULL DEFAULT 0,
      message INTEGER, PRIMARY KEY(chat, seed, user));`);
  }
  player(chat: number, seed: string, user: number): Player | null {
    return this.db
      .query<Player, [number, string, number]>(
        "SELECT * FROM mines_players WHERE chat=? AND seed=? AND user=?",
      )
      .get(chat, seed, user);
  }
  view(player: Player): JsonObject {
    const opened = JSON.parse(player.opened) as number[];
    const mines = minefield(player.seed);
    const done = player.ended !== null;
    const status = done
      ? `${player.lost ? "💥 Подрыв" : "🏁 Победа"} · ${(((player.ended ?? 0) - (player.started ?? 0)) / 1000).toFixed(2)} с`
      : player.started === null
        ? "Нажми ▶ для старта"
        : `Открыто ${opened.length}/30`;
    const rows = Array.from({ length: size }, (_, y) =>
      Array.from({ length: size }, (_, x) => {
        const i = y * size + x;
        const count = neighbors(i).filter((n) => mines.has(n)).length;
        return {
          text:
            done && mines.has(i)
              ? "💣"
              : opened.includes(i)
                ? count
                  ? String(count)
                  : "·"
                : player.started === null && i === start
                  ? "▶"
                  : "■",
          callback_data: `mine:${player.seed}:${player.user}:${i}`,
        };
      }),
    );
    return {
      text: `Сапёр 6×6 · 6 мин\n${player.name}\n${status}\nПрисоединиться: /mines ${player.seed}\nРезультаты: /mines top ${player.seed}\nОдна попытка на игрока. Поля видны в чате; это дружеский забег.`,
      reply_markup: { inline_keyboard: rows },
    };
  }
  async command(message: TelegramMessage, username?: string): Promise<boolean> {
    const match = message.text?.match(/^\/mines(?:@([\w]+))?(?:\s+(.*))?$/i);
    if (!match || (match[1] && match[1].toLowerCase() !== username?.toLowerCase())) return false;
    const user = message.from;
    if (!user || user.is_bot || !Number.isSafeInteger(user.id)) return true;
    const args = (match[2] ?? "").trim().split(/\s+/).filter(Boolean);
    const send = (text: string) =>
      this.telegram.call("sendMessage", {
        chat_id: message.chat.id,
        text,
        reply_parameters: { message_id: message.message_id },
        ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      });
    if (args[0] === "top" && args.length === 2 && /^[a-f0-9]{12}$/.test(args[1] ?? "")) {
      const players = this.db
        .query<Player, [number, string]>(
          "SELECT * FROM mines_players WHERE chat=? AND seed=? ORDER BY lost, (ended IS NULL), (ended-started) LIMIT 50",
        )
        .all(message.chat.id, args[1] ?? "");
      await send(
        players.length
          ? players
              .map(
                (p) =>
                  `${p.name}: ${p.ended === null ? "играет" : p.lost ? "💥" : `${(((p.ended ?? 0) - (p.started ?? 0)) / 1000).toFixed(2)} с`}`,
              )
              .join("\n")
          : "Забег не найден.",
      );
      return true;
    }
    if (args.length > 1 || (args.length === 1 && !/^[a-f0-9]{12}$/.test(args[0] ?? ""))) {
      await send("/mines — новый забег\n/mines КОД — то же поле\n/mines top КОД — результаты");
      return true;
    }
    const seed = args[0] ?? randomBytes(6).toString("hex");
    if (
      args.length &&
      !this.db
        .query("SELECT 1 FROM mines_players WHERE chat=? AND seed=? LIMIT 1")
        .get(message.chat.id, seed)
    ) {
      await send("Забег не найден в этом чате. Создай новый: /mines");
      return true;
    }
    this.db
      .query("INSERT OR IGNORE INTO mines_players(chat,seed,user,name) VALUES (?,?,?,?)")
      .run(message.chat.id, seed, user.id, user.first_name.slice(0, 80));
    const player = this.player(message.chat.id, seed, user.id);
    if (!player) return true;
    const sent = await this.telegram.call<TelegramMessage>("sendMessage", {
      chat_id: message.chat.id,
      ...this.view(player),
      reply_parameters: { message_id: message.message_id },
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    });
    this.db
      .query("UPDATE mines_players SET message=? WHERE chat=? AND seed=? AND user=?")
      .run(sent.message_id, message.chat.id, seed, user.id);
    return true;
  }
  async callback(update: TelegramUpdate): Promise<boolean> {
    const callback = update.callback_query;
    if (!callback?.data?.startsWith("mine:")) return false;
    const match = callback.data.match(/^mine:([a-f0-9]{12}):(\d+):(\d+)$/);
    const message = callback.message;
    const user = callback.from;
    const cell = Number(match?.[3]);
    const player = match && message ? this.player(message.chat.id, match[1] ?? "", user.id) : null;
    if (
      !match ||
      !message ||
      !player ||
      user.is_bot ||
      Number(match[2]) !== user.id ||
      player.message !== message.message_id ||
      cell < 0 ||
      cell >= 36 ||
      !Number.isInteger(cell)
    ) {
      await this.telegram.answerCallbackQuery(
        callback.id,
        "Это чужое или старое поле. Присоединяйся через /mines КОД.",
      );
      return true;
    }
    if (player.ended !== null || (player.started === null && cell !== start)) {
      await this.telegram.answerCallbackQuery(
        callback.id,
        player.ended !== null ? "Попытка завершена" : "Начни с ▶",
      );
      return true;
    }
    const mines = minefield(player.seed);
    const now = Date.now();
    const opened = reveal(mines, JSON.parse(player.opened), cell);
    player.started ??= now;
    player.lost = mines.has(cell) ? 1 : 0;
    player.ended = player.lost || opened.length === 30 ? now : null;
    player.opened = JSON.stringify(opened);
    this.db
      .query(
        "UPDATE mines_players SET opened=?,started=?,ended=?,lost=? WHERE chat=? AND seed=? AND user=?",
      )
      .run(
        player.opened,
        player.started,
        player.ended,
        player.lost,
        player.chat,
        player.seed,
        player.user,
      );
    await this.telegram.answerCallbackQuery(callback.id);
    // Always repaint, so a retry also repairs a failed previous Telegram edit.
    try {
      await this.telegram.call("editMessageText", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        ...this.view(player),
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("message is not modified"))
        throw error;
    }
    return true;
  }
}
