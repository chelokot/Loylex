import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LoylexDatabase } from "../src/gateway/database.ts";
import type {
  JsonObject,
  TelegramMessage,
  TelegramMessageOrigin,
  TelegramUpdate,
} from "../src/shared/types.ts";

import {
  forwardedMessage,
  message,
  removeDatabases,
  setup,
  temporaryDirectory,
} from "./fixtures/database.ts";

afterEach(removeDatabases);

describe("LoylexDatabase", () => {
  test("normalizes chats and users and archives reaction updates", () => {
    const database = setup();
    const target = message(1, "сообщение с реакцией");
    database.archiveMessage(target, "bot_api");

    expect(
      database.connection
        .query<{ chat_id: number; chat_type: string; chat_title: string | null }, [number]>(
          "SELECT chat_id, chat_type, chat_title FROM chats WHERE chat_id = ?",
        )
        .get(-10042),
    ).toEqual({ chat_id: -10042, chat_type: "supergroup", chat_title: "Test" });
    expect(
      database.connection
        .query<{ user_id: number; username: string | null; display_name: string | null }, [number]>(
          "SELECT user_id, username, display_name FROM users WHERE user_id = ?",
        )
        .get(7),
    ).toEqual({ user_id: 7, username: "chelokot", display_name: "Andrii" });

    const messageColumns = database.connection
      .query<{ name: string }, []>("PRAGMA table_info(messages)")
      .all()
      .map((column) => column.name);
    expect(messageColumns).not.toContain("chat_type");
    expect(messageColumns).not.toContain("chat_title");
    expect(messageColumns).not.toContain("from_username");
    expect(messageColumns).not.toContain("from_display_name");
    expect(
      database.connection
        .query<{ table: string; from: string; to: string }, []>("PRAGMA foreign_key_list(messages)")
        .all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "chats", from: "chat_id", to: "chat_id" }),
        expect.objectContaining({ table: "users", from: "from_user_id", to: "user_id" }),
      ]),
    );
    expect(database.search("chelokot", null, 10).map((result) => result.messageId)).toEqual([1]);

    database.archiveUpdate({
      update_id: 700,
      message_reaction: {
        chat: target.chat,
        message_id: target.message_id,
        user: { id: 8, is_bot: false, first_name: "Artem", username: "ExposedCat" },
        date: 1_700_000_700,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👎" }],
      },
    });
    database.archiveUpdate({
      update_id: 701,
      message_reaction_count: {
        chat: target.chat,
        message_id: target.message_id,
        date: 1_700_000_701,
        reactions: [{ type: { type: "emoji", emoji: "🔥" }, total_count: 3 }],
      },
    });
    database.archiveUpdate({
      update_id: 702,
      message_reaction: {
        chat: target.chat,
        message_id: 999,
        user: { id: 8, is_bot: false, first_name: "Artem", username: "ExposedCat" },
        date: 1_700_000_702,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👎" }],
      },
    });

    expect(
      database.connection
        .query<{ event_type: string; user_id: number | null; new_reaction_json: string }, [number]>(
          "SELECT event_type, user_id, new_reaction_json FROM reactions WHERE update_id = ?",
        )
        .get(700),
    ).toEqual({
      event_type: "message_reaction",
      user_id: 8,
      new_reaction_json: '[{"type":"emoji","emoji":"👎"}]',
    });
    expect(
      database.connection
        .query<{ counts_json: string }, [number]>(
          "SELECT counts_json FROM reactions WHERE update_id = ?",
        )
        .get(701),
    ).toEqual({ counts_json: '[{"type":{"type":"emoji","emoji":"🔥"},"total_count":3}]' });
    expect(
      database.connection
        .query<{ count: number }, []>("SELECT count(*) AS count FROM reactions")
        .get()?.count,
    ).toBe(2);
    expect(
      database.connection
        .query<{ event_type: string; raw_json: string }, [number]>(
          "SELECT event_type, raw_json FROM updates WHERE update_id = ?",
        )
        .get(702),
    ).toMatchObject({ event_type: "message_reaction" });
    database.close();
  });

  test("migrates legacy messages and backfills known reaction updates", () => {
    const directory = temporaryDirectory("loylex-legacy-");
    const path = join(directory, "test.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE updates (
        update_id INTEGER PRIMARY KEY,
        event_type TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        raw_json TEXT NOT NULL
      );
      CREATE TABLE messages (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        message_thread_id INTEGER,
        chat_type TEXT NOT NULL,
        chat_title TEXT,
        date INTEGER NOT NULL,
        edit_date INTEGER,
        from_user_id INTEGER,
        from_username TEXT,
        from_display_name TEXT,
        text TEXT,
        reply_to_message_id INTEGER,
        media_group_id TEXT,
        media_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'bot_api',
        PRIMARY KEY (chat_id, message_id)
      );
    `);
    const legacyMessage: TelegramMessage = {
      ...message(1, "legacy message"),
      from: { id: 7, is_bot: false, first_name: "Legacy", username: "legacyuser" },
    };
    legacy
      .query(`
        INSERT INTO messages (
          chat_id, message_id, message_thread_id, chat_type, chat_title, date, edit_date,
          from_user_id, from_username, from_display_name, text, reply_to_message_id,
          media_group_id, media_json, raw_json, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        legacyMessage.chat.id,
        legacyMessage.message_id,
        null,
        legacyMessage.chat.type,
        legacyMessage.chat.title ?? null,
        legacyMessage.date,
        null,
        legacyMessage.from?.id ?? null,
        legacyMessage.from?.username ?? null,
        "Legacy",
        legacyMessage.text ?? null,
        null,
        null,
        "[]",
        JSON.stringify(legacyMessage),
        "bot_api",
      );
    const reactionUpdate: TelegramUpdate = {
      update_id: 901,
      message_reaction: {
        chat: legacyMessage.chat,
        message_id: legacyMessage.message_id,
        user: { id: 8, is_bot: false, first_name: "Reactor" },
        date: 1_700_000_901,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👎" }],
      },
    };
    legacy
      .query("INSERT INTO updates VALUES (?, ?, ?, ?)")
      .run(901, "message_reaction", Date.now(), JSON.stringify(reactionUpdate));
    legacy.close();

    const database = new LoylexDatabase(path);
    expect(database.connection.query("SELECT * FROM chats WHERE chat_id = ?").get(-10042)).toEqual({
      chat_id: -10042,
      chat_type: "supergroup",
      chat_title: "Test",
    });
    expect(database.connection.query("SELECT * FROM users WHERE user_id = ?").get(7)).toMatchObject(
      { user_id: 7, username: "legacyuser", display_name: "Legacy" },
    );
    expect(database.search("legacyuser", null, 10).map((result) => result.messageId)).toEqual([1]);
    expect(
      database.connection
        .query("SELECT update_id, user_id FROM reactions WHERE update_id = ?")
        .get(901),
    ).toEqual({ update_id: 901, user_id: 8 });
    database.close();
  });

  test("updates edited messages without duplicating them", () => {
    const database = setup();
    database.archiveMessage(message(2, "первая версия"), "bot_api");
    database.archiveMessage(message(2, "исправленная версия"), "bot_api");

    expect(database.stats().messages).toBe(1);
    expect(database.search("исправленная", null, 10)[0]?.messageId).toBe(2);
    expect(database.search("первая", null, 10)).toHaveLength(0);
    database.close();
  });

  test("exposes the full forward origin in archive results and context", () => {
    const database = setup();
    const forwarded = forwardedMessage(1, "пересланное сообщение");
    const origin = forwarded.forward_origin as JsonObject;
    database.archiveMessage(forwarded, "bot_api");

    expect(database.recent(-10042, 1)[0]?.forwardOrigin).toEqual(origin);
    expect(database.search("пересланное", -10042, 1)[0]?.forwardOrigin).toEqual(origin);

    const current = message(2, "Лойлекс, покажи источник");
    database.archiveMessage(current, "bot_api");
    database.enqueue(56, current, "покажи источник", null);
    const job = database.claimNext(10);
    expect(job?.context).toContain('forwarded_from="chelokot"');
    expect(job?.context).toContain('forward_origin={"type":"user"');
    expect(job?.context).toContain('"sender_user":{"id":42');
    database.close();
  });

  test("does not update an unchanged archived user", () => {
    const database = setup();
    database.archiveMessage(message(1, "первое сообщение"), "bot_api");
    database.connection.exec(`
      CREATE TEMP TABLE user_update_audit (updates INTEGER NOT NULL);
      INSERT INTO user_update_audit VALUES (0);
      CREATE TEMP TRIGGER users_update_audit AFTER UPDATE ON users BEGIN
        UPDATE user_update_audit SET updates = updates + 1;
      END;
    `);

    database.archiveMessage(message(2, "второе сообщение"), "bot_api");

    expect(
      database.connection
        .query<{ updates: number }, []>("SELECT updates FROM user_update_audit")
        .get()?.updates,
    ).toBe(0);
    database.close();
  });

  test("formats chat, channel, and hidden-user forward origins", () => {
    const database = setup();
    const origins = [
      {
        messageId: 1,
        origin: {
          type: "chat",
          date: 1_700_000_501,
          sender_chat: { id: -10042, type: "supergroup", title: "Test" },
        },
      },
      {
        messageId: 2,
        origin: {
          type: "channel",
          date: 1_700_000_502,
          chat: { id: -10077, type: "channel", title: "News" },
          message_id: 987,
        },
      },
      {
        messageId: 3,
        origin: {
          type: "hidden_user",
          date: 1_700_000_503,
          sender_user_name: "Скрытый автор",
        },
      },
    ] satisfies Array<{ messageId: number; origin: TelegramMessageOrigin }>;

    for (const item of origins) {
      const forwarded = message(item.messageId, `сообщение ${item.messageId}`);
      forwarded.forward_origin = item.origin;
      database.archiveMessage(forwarded, "bot_api");
    }
    const current = message(4, "Лойлекс, проверь типы пересылок");
    database.archiveMessage(current, "bot_api");
    database.enqueue(56, current, "проверь типы пересылок", null);

    const job = database.claimNext(10);
    for (const item of origins) {
      expect(job?.context).toContain(`forward_origin=${JSON.stringify(item.origin)}`);
      expect(
        database.recent(-10042, 10).find((result) => result.messageId === item.messageId),
      ).toMatchObject({ forwardOrigin: item.origin });
    }
    database.close();
  });
});
