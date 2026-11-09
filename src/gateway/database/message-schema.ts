import type {
  TelegramChat,
  TelegramMessageReactionCountUpdated,
  TelegramMessageReactionUpdated,
  TelegramUpdate,
  TelegramUser,
} from "../../shared/types.ts";
import { DatabaseConnection } from "./connection.ts";
import { displayNameForUser, parseObject } from "./records.ts";

export abstract class DatabaseMessageSchema extends DatabaseConnection {
  protected tableExists(name: string): boolean {
    return Boolean(
      this.connection
        .query<{ value: number }, [string]>(
          "SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name),
    );
  }

  protected messageColumns(): Set<string> {
    return new Set(
      this.connection
        .query<{ name: string }, []>("PRAGMA table_info(messages)")
        .all()
        .map((column) => column.name),
    );
  }

  protected messagesHaveIdentityForeignKeys(): boolean {
    const foreignKeys = this.connection
      .query<{ table: string; from: string; to: string }, []>("PRAGMA foreign_key_list(messages)")
      .all();
    return (
      foreignKeys.some(
        (foreignKey) =>
          foreignKey.table === "chats" &&
          foreignKey.from === "chat_id" &&
          foreignKey.to === "chat_id",
      ) &&
      foreignKeys.some(
        (foreignKey) =>
          foreignKey.table === "users" &&
          foreignKey.from === "from_user_id" &&
          foreignKey.to === "user_id",
      )
    );
  }

  protected searchIndexIsCurrent(): boolean {
    const sql = this.connection
      .query<{ sql: string | null }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("messages_fts")?.sql;
    if (!sql) {
      return false;
    }
    const normalized = sql.toLowerCase().replaceAll(" ", "");
    return normalized.includes("content=''") && normalized.includes("contentless_delete=1");
  }

  protected createMessagesTable(name: "messages" | "messages_new"): void {
    this.connection.exec(`
      CREATE TABLE ${name} (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        message_thread_id INTEGER,
        date INTEGER NOT NULL,
        edit_date INTEGER,
        from_user_id INTEGER,
        text TEXT,
        reply_to_message_id INTEGER,
        media_group_id TEXT,
        media_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'bot_api',
        PRIMARY KEY (chat_id, message_id),
        FOREIGN KEY (chat_id) REFERENCES chats(chat_id),
        FOREIGN KEY (from_user_id) REFERENCES users(user_id)
      );
    `);
  }

  protected populateIdentityTablesFromLegacyMessages(): void {
    this.connection.exec(`
      WITH latest_chats AS (
        SELECT chat_id, chat_type, chat_title,
               ROW_NUMBER() OVER (
                 PARTITION BY chat_id ORDER BY date DESC, message_id DESC
               ) AS row_number
        FROM messages
      )
      INSERT INTO chats (chat_id, chat_type, chat_title)
      SELECT chat_id, chat_type, chat_title
      FROM latest_chats
      WHERE row_number = 1
      ON CONFLICT(chat_id) DO UPDATE SET
        chat_type = excluded.chat_type,
        chat_title = COALESCE(excluded.chat_title, chats.chat_title);

      WITH latest_users AS (
        SELECT from_user_id, from_username, from_display_name,
               ROW_NUMBER() OVER (
                 PARTITION BY from_user_id ORDER BY date DESC, message_id DESC
               ) AS row_number
        FROM messages
        WHERE from_user_id IS NOT NULL
      )
      INSERT INTO users (user_id, username, display_name)
      SELECT from_user_id, from_username, from_display_name
      FROM latest_users
      WHERE row_number = 1
      ON CONFLICT(user_id) DO UPDATE SET
        username = COALESCE(excluded.username, users.username),
        display_name = COALESCE(excluded.display_name, users.display_name);
    `);
  }

  protected dropSearchObjects(): void {
    this.connection.exec(`
      DROP TRIGGER IF EXISTS messages_ai;
      DROP TRIGGER IF EXISTS messages_ad;
      DROP TRIGGER IF EXISTS messages_au;
      DROP TRIGGER IF EXISTS users_au;
      DROP TABLE IF EXISTS messages_fts;
    `);
  }

  protected rebuildMessages(): void {
    this.dropSearchObjects();
    this.connection.exec("DROP TABLE IF EXISTS messages_new");
    this.createMessagesTable("messages_new");
    this.connection.exec(`
      INSERT INTO messages_new (
        rowid, chat_id, message_id, message_thread_id, date, edit_date, from_user_id, text,
        reply_to_message_id, media_group_id, media_json, raw_json, source
      )
      SELECT rowid, chat_id, message_id, message_thread_id, date, edit_date, from_user_id, text,
             reply_to_message_id, media_group_id, media_json, raw_json, source
      FROM messages;

      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;
    `);
  }

  protected createSearchIndex(rebuild: boolean): void {
    this.connection.exec(`
      DROP TRIGGER IF EXISTS messages_ai;
      DROP TRIGGER IF EXISTS messages_ad;
      DROP TRIGGER IF EXISTS messages_au;
      DROP TRIGGER IF EXISTS users_au;
    `);
    if (rebuild) {
      this.connection.exec("DROP TABLE IF EXISTS messages_fts");
    }
    this.connection.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        from_display_name,
        from_username,
        content='',
        contentless_delete=1,
        tokenize='unicode61'
      );

      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text, from_display_name, from_username)
        SELECT new.rowid, new.text, users.display_name, users.username
        FROM (SELECT 1) AS one
        LEFT JOIN users ON users.user_id = new.from_user_id;
      END;

      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
      END;

      CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
        INSERT INTO messages_fts(rowid, text, from_display_name, from_username)
        SELECT new.rowid, new.text, users.display_name, users.username
        FROM (SELECT 1) AS one
        LEFT JOIN users ON users.user_id = new.from_user_id;
      END;

      CREATE TRIGGER users_au AFTER UPDATE OF username, display_name ON users
      WHEN old.username IS NOT new.username OR old.display_name IS NOT new.display_name
      BEGIN
        DELETE FROM messages_fts
        WHERE rowid IN (
          SELECT rowid FROM messages WHERE from_user_id = old.user_id
        );
        INSERT INTO messages_fts(rowid, text, from_display_name, from_username)
        SELECT messages.rowid, messages.text, new.display_name, new.username
        FROM messages
        WHERE messages.from_user_id = new.user_id;
      END;
    `);
    if (rebuild) {
      this.connection.exec(`
        INSERT INTO messages_fts(rowid, text, from_display_name, from_username)
        SELECT messages.rowid, messages.text, users.display_name, users.username
        FROM messages
        LEFT JOIN users ON users.user_id = messages.from_user_id;
      `);
    }
  }

  protected migrateMessages(): void {
    let rebuildMessages = false;
    if (!this.tableExists("messages")) {
      this.createMessagesTable("messages");
      rebuildMessages = true;
    } else {
      const columns = this.messageColumns();
      const legacyIdentityColumns = [
        "chat_type",
        "chat_title",
        "from_username",
        "from_display_name",
      ].some((column) => columns.has(column));
      rebuildMessages = legacyIdentityColumns || !this.messagesHaveIdentityForeignKeys();
      if (legacyIdentityColumns) {
        this.populateIdentityTablesFromLegacyMessages();
      }
      if (rebuildMessages) {
        this.rebuildMessages();
      }
    }
    this.createSearchIndex(rebuildMessages || !this.searchIndexIsCurrent());
  }

  protected migrateNormalizedSchema(): void {
    const transaction = this.connection.transaction(() => {
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS chats (
          chat_id INTEGER PRIMARY KEY,
          chat_type TEXT NOT NULL,
          chat_title TEXT
        );

        CREATE TABLE IF NOT EXISTS users (
          user_id INTEGER PRIMARY KEY,
          username TEXT,
          display_name TEXT
        );
      `);
      this.migrateMessages();
      this.connection.exec(`
        CREATE INDEX IF NOT EXISTS messages_chat_date_idx ON messages(chat_id, date DESC);
        CREATE INDEX IF NOT EXISTS messages_context_idx
          ON messages(chat_id, date DESC, message_id DESC);

        CREATE TABLE IF NOT EXISTS reactions (
          update_id INTEGER PRIMARY KEY,
          chat_id INTEGER NOT NULL,
          message_id INTEGER NOT NULL,
          date INTEGER NOT NULL,
          event_type TEXT NOT NULL CHECK (event_type IN ('message_reaction', 'message_reaction_count')),
          user_id INTEGER,
          actor_chat_id INTEGER,
          old_reaction_json TEXT NOT NULL DEFAULT '[]',
          new_reaction_json TEXT NOT NULL DEFAULT '[]',
          counts_json TEXT NOT NULL DEFAULT '[]',
          FOREIGN KEY (update_id) REFERENCES updates(update_id) ON DELETE CASCADE,
          FOREIGN KEY (chat_id, message_id) REFERENCES messages(chat_id, message_id) ON DELETE CASCADE,
          FOREIGN KEY (actor_chat_id) REFERENCES chats(chat_id),
          FOREIGN KEY (user_id) REFERENCES users(user_id)
        );
        CREATE INDEX IF NOT EXISTS reactions_message_date_idx
          ON reactions(chat_id, message_id, date DESC);
        CREATE INDEX IF NOT EXISTS reactions_user_date_idx ON reactions(user_id, date DESC);
      `);
      this.backfillReactions();
    });
    transaction.immediate();
  }

  protected upsertChat(chat: TelegramChat): void {
    this.connection
      .query(`
        INSERT INTO chats (chat_id, chat_type, chat_title)
        VALUES (?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          chat_type = excluded.chat_type,
          chat_title = COALESCE(excluded.chat_title, chats.chat_title)
      `)
      .run(chat.id, chat.type, chat.title ?? null);
  }

  protected upsertUser(user: TelegramUser): void {
    this.connection
      .query(`
        INSERT INTO users (user_id, username, display_name)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          username = COALESCE(excluded.username, users.username),
          display_name = COALESCE(excluded.display_name, users.display_name)
        WHERE users.username IS NOT COALESCE(excluded.username, users.username)
           OR users.display_name IS NOT COALESCE(excluded.display_name, users.display_name)
      `)
      .run(user.id, user.username ?? null, displayNameForUser(user));
  }

  protected messageExists(chatId: number, messageId: number): boolean {
    return Boolean(
      this.connection
        .query<{ value: number }, [number, number]>(
          "SELECT 1 AS value FROM messages WHERE chat_id = ? AND message_id = ? LIMIT 1",
        )
        .get(chatId, messageId),
    );
  }

  protected archiveReaction(
    updateId: number,
    eventType: "message_reaction" | "message_reaction_count",
    reaction: TelegramMessageReactionUpdated | TelegramMessageReactionCountUpdated,
  ): void {
    if (!this.messageExists(reaction.chat.id, reaction.message_id)) {
      return;
    }

    this.upsertChat(reaction.chat);
    const isUserReaction = eventType === "message_reaction";
    const userReaction = isUserReaction ? (reaction as TelegramMessageReactionUpdated) : null;
    const countReaction = isUserReaction ? null : (reaction as TelegramMessageReactionCountUpdated);
    if (userReaction?.user) {
      this.upsertUser(userReaction.user);
    }
    if (userReaction?.actor_chat) {
      this.upsertChat(userReaction.actor_chat);
    }
    this.connection
      .query(`
        INSERT OR IGNORE INTO reactions (
          update_id, chat_id, message_id, date, event_type, user_id, actor_chat_id,
          old_reaction_json, new_reaction_json, counts_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        updateId,
        reaction.chat.id,
        reaction.message_id,
        reaction.date,
        eventType,
        userReaction?.user?.id ?? null,
        userReaction?.actor_chat?.id ?? null,
        JSON.stringify(userReaction?.old_reaction ?? []),
        JSON.stringify(userReaction?.new_reaction ?? []),
        JSON.stringify(countReaction?.reactions ?? []),
      );
  }

  protected backfillReactions(): void {
    const rows = this.connection
      .query<{ update_id: number; raw_json: string }, []>(`
        SELECT update_id, raw_json
        FROM updates
        WHERE event_type IN ('message_reaction', 'message_reaction_count')
      `)
      .all();
    for (const row of rows) {
      const update = parseObject(row.raw_json) as unknown as TelegramUpdate;
      if (update.message_reaction) {
        this.archiveReaction(row.update_id, "message_reaction", update.message_reaction);
      }
      if (update.message_reaction_count) {
        this.archiveReaction(
          row.update_id,
          "message_reaction_count",
          update.message_reaction_count,
        );
      }
    }
  }
}
