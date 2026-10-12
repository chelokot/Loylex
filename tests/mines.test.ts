import { expect, test } from "bun:test";
import { MinesGame, minefield, neighbors, reveal } from "../src/gateway/mines.ts";
import type { TelegramClient } from "../src/gateway/telegram.ts";
import type { TelegramMessage } from "../src/shared/types.ts";

test("shared seeds have six mines and a safe expanding fixed start", () => {
  for (let i = 0; i < 100; i++) {
    const field = minefield(String(i));
    expect(field.size).toBe(6);
    expect([...field]).toEqual([...minefield(String(i))]);
    expect([14, ...neighbors(14)].some((n) => field.has(n))).toBe(false);
    const opened = reveal(field, [], 14);
    expect(opened.length).toBeGreaterThanOrEqual(9);
    expect(opened.some((n) => field.has(n))).toBe(false);
    expect(reveal(field, opened, 14)).toEqual(opened);
    let all = opened;
    for (let n = 0; n < 36; n++) if (!field.has(n)) all = reveal(field, all, n);
    expect(all.length).toBe(30);
  }
});

test("players have separate progress, foreign clicks fail, attempts cannot reset", async () => {
  let id = 100;
  const telegram = {
    call: async () => ({ message_id: id++ }),
    answerCallbackQuery: async () => true,
  } as unknown as TelegramClient;
  const game = new MinesGame(":memory:", telegram);
  const message = (user: number, text: string): TelegramMessage => ({
    message_id: 1,
    date: 0,
    chat: { id: -1, type: "supergroup" },
    from: { id: user, first_name: "Test", is_bot: false },
    text,
  });
  await game.command(message(1, "/mines"));
  const seed = (game.db.query("SELECT seed FROM mines_players").get() as { seed: string }).seed;
  await game.command(message(2, `/mines ${seed}`));
  const click = (user: number, owner: number, cell: number, messageId: number) =>
    game.callback({
      update_id: 1,
      callback_query: {
        id: "q",
        chat_instance: "test",
        from: { id: user, first_name: "Test", is_bot: false },
        data: `mine:${seed}:${owner}:${cell}`,
        message: { ...message(user, ""), message_id: messageId },
      },
    });
  await click(2, 1, 14, 100);
  expect(game.player(-1, seed, 1)?.started).toBeNull();
  await click(1, 1, 14, 100);
  expect(game.player(-1, seed, 1)?.started).not.toBeNull();
  expect(game.player(-1, seed, 2)?.started).toBeNull();
  await click(1, 1, [...minefield(seed)][0] ?? 0, 100);
  expect(game.player(-1, seed, 1)?.lost).toBe(1);
  await game.command(message(1, `/mines ${seed}`));
  expect(game.player(-1, seed, 1)?.lost).toBe(1);
  game.db.close();
});
