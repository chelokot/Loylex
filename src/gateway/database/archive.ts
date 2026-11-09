import type { Database } from "bun:sqlite";
import { messageText } from "../../shared/message-text.ts";
import type { JsonValue, TelegramMessage, TelegramUpdate } from "../../shared/types.ts";
import {
  defaultReadQueryRows,
  maxReadQueryResultBytes,
  maxReadQueryRows,
  ReadQueryError,
  type ReadQueryParameters,
  validateReadOnlyQuery,
} from "../read-query.ts";
import { archivedMessage, eventType, media, searchResult } from "./records.ts";
import { DatabaseSchema } from "./schema.ts";
import type {
  ArchivedMedia,
  ArchivedMessage,
  ArchivedMessageRow,
  ReadQueryResult,
  SearchResult,
  SearchRow,
} from "./types.ts";

export abstract class DatabaseArchive extends DatabaseSchema {
  archiveUpdate(update: TelegramUpdate): TelegramMessage | null {
    const message =
      update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
    const transaction = this.connection.transaction(() => {
      this.connection
        .query(`
          INSERT INTO update_cursor (id, update_id) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET update_id = max(update_cursor.update_id, excluded.update_id)
        `)
        .run(update.update_id);

      this.connection
        .query("INSERT OR IGNORE INTO updates VALUES (?, ?, ?, ?)")
        .run(update.update_id, eventType(update), Date.now(), JSON.stringify(update));

      if (message) {
        this.archiveMessage(message, "bot_api");
      }
      if (update.message_reaction) {
        this.archiveReaction(update.update_id, "message_reaction", update.message_reaction);
      }
      if (update.message_reaction_count) {
        this.archiveReaction(
          update.update_id,
          "message_reaction_count",
          update.message_reaction_count,
        );
      }
      return message ?? null;
    });
    return transaction.immediate();
  }

  archiveMessage(message: TelegramMessage, source: "bot_api" | "telegram_export"): void {
    this.upsertChat(message.chat);
    if (message.from) {
      this.upsertUser(message.from);
    }
    const text = messageText(message) || null;
    this.connection
      .query(`
        INSERT INTO messages (
          chat_id, message_id, message_thread_id, date, edit_date, from_user_id, text,
          reply_to_message_id, media_group_id, media_json, raw_json, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, message_id) DO UPDATE SET
          message_thread_id=excluded.message_thread_id,
          date=excluded.date,
          edit_date=excluded.edit_date,
          from_user_id=COALESCE(excluded.from_user_id, messages.from_user_id),
          text=excluded.text,
          reply_to_message_id=excluded.reply_to_message_id,
          media_group_id=excluded.media_group_id,
          media_json=excluded.media_json,
          raw_json=excluded.raw_json,
          source=excluded.source
      `)
      .run(
        message.chat.id,
        message.message_id,
        message.message_thread_id ?? null,
        message.date,
        message.edit_date ?? null,
        message.from?.id ?? null,
        text,
        message.reply_to_message?.message_id ?? null,
        message.media_group_id ?? null,
        JSON.stringify(media(message)),
        JSON.stringify(message),
        source,
      );
  }

  archiveExportMessages(messages: TelegramMessage[]): number {
    const transaction = this.connection.transaction(() => {
      for (const message of messages) {
        this.archiveMessage(message, "telegram_export");
      }
      return messages.length;
    });
    return transaction.immediate();
  }

  archivedMedia(chatId: number, limit: number): ArchivedMedia[] {
    const rows = this.connection
      .query<
        { chat_id: number; message_id: number; date: number; media_json: string; source: string },
        [number, number]
      >(
        `
          SELECT chat_id, message_id, date, media_json, source
          FROM messages
          WHERE chat_id = ? AND media_json != '[]'
          ORDER BY date ASC, message_id ASC
          LIMIT ?
        `,
      )
      .all(chatId, limit);
    return rows.map((row) => ({
      chatId: row.chat_id,
      messageId: row.message_id,
      date: row.date,
      source: row.source as ArchivedMedia["source"],
      media: JSON.parse(row.media_json) as JsonValue[],
    }));
  }

  archivedMessage(chatId: number, messageId: number): ArchivedMessage | null {
    const row = this.connection
      .query<ArchivedMessageRow, [number, number]>(`
        SELECT messages.chat_id, messages.message_id, messages.date, messages.from_user_id,
               users.display_name AS from_display_name, users.username AS from_username,
               messages.text, messages.reply_to_message_id, messages.media_group_id,
               messages.media_json, messages.raw_json, messages.source
        FROM messages
        LEFT JOIN users ON users.user_id = messages.from_user_id
        WHERE messages.chat_id = ? AND messages.message_id = ?
      `)
      .get(chatId, messageId);
    return row ? archivedMessage(row) : null;
  }

  archivedMessages(
    chatId: number,
    afterMessageId: number | null,
    beforeMessageId: number | null,
    limit: number,
  ): ArchivedMessage[] {
    const rows = this.connection
      .query<
        ArchivedMessageRow,
        [number, number | null, number | null, number | null, number | null, number]
      >(`
        SELECT messages.chat_id, messages.message_id, messages.date, messages.from_user_id,
               users.display_name AS from_display_name, users.username AS from_username,
               messages.text, messages.reply_to_message_id, messages.media_group_id,
               messages.media_json, messages.raw_json, messages.source
        FROM messages
        LEFT JOIN users ON users.user_id = messages.from_user_id
        WHERE messages.chat_id = ?
          AND (? IS NULL OR messages.message_id > ?)
          AND (? IS NULL OR messages.message_id < ?)
        ORDER BY messages.message_id ASC
        LIMIT ?
      `)
      .all(chatId, afterMessageId, afterMessageId, beforeMessageId, beforeMessageId, limit);
    return rows.map(archivedMessage);
  }

  chatExists(chatId: number): boolean {
    return Boolean(
      this.connection
        .query<{ value: number }, [number]>(
          "SELECT 1 AS value FROM chats WHERE chat_id = ? LIMIT 1",
        )
        .get(chatId),
    );
  }

  search(query: string, chatId: number | null, limit: number, offset = 0): SearchResult[] {
    const rows = this.connection
      .query<SearchRow, [string, number | null, number | null, number, number]>(`
        SELECT m.chat_id, m.message_id, m.date, m.from_user_id,
               u.display_name AS from_display_name, u.username AS from_username,
               m.text, m.raw_json
        FROM messages_fts f
        JOIN messages m ON m.rowid = f.rowid
        LEFT JOIN users u ON u.user_id = m.from_user_id
        WHERE messages_fts MATCH ?
          AND (? IS NULL OR m.chat_id = ?)
        ORDER BY bm25(messages_fts), m.date DESC
        LIMIT ? OFFSET ?
      `)
      .all(query, chatId, chatId, limit, offset);
    return rows.map(searchResult);
  }

  readQuery(
    sql: string,
    parameters: ReadQueryParameters = [],
    maxRows = defaultReadQueryRows,
  ): ReadQueryResult {
    validateReadOnlyQuery(sql);
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > maxReadQueryRows) {
      throw new ReadQueryError(`maxRows must be an integer from 1 to ${maxReadQueryRows}`);
    }

    let statement: ReturnType<Database["query"]> | null = null;
    try {
      statement = this.readConnection.query(sql);
      const rows: Record<string, unknown>[] = [];
      let resultBytes = 0;
      let truncated = false;
      const rowsIterator = Array.isArray(parameters)
        ? statement.iterate(...parameters)
        : statement.iterate(parameters);
      const encoder = new TextEncoder();
      for (const row of rowsIterator) {
        if (rows.length >= maxRows) {
          truncated = true;
          break;
        }
        const rowBytes = encoder.encode(JSON.stringify(row)).byteLength;
        if (resultBytes + rowBytes > maxReadQueryResultBytes) {
          if (rows.length === 0) {
            throw new ReadQueryError(
              `the first result row exceeds the ${maxReadQueryResultBytes}-byte result limit`,
            );
          }
          truncated = true;
          break;
        }
        rows.push(row as Record<string, unknown>);
        resultBytes += rowBytes;
      }
      return { columns: statement.columnNames, rows, truncated };
    } catch (error) {
      if (error instanceof ReadQueryError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ReadQueryError(`read-only query failed: ${message}`);
    } finally {
      statement?.finalize();
    }
  }

  recent(chatId: number, limit: number): SearchResult[] {
    const rows = this.connection
      .query<SearchRow, [number, number]>(`
        SELECT messages.chat_id, messages.message_id, messages.date, messages.from_user_id,
               users.display_name AS from_display_name, users.username AS from_username,
               messages.text, messages.raw_json
        FROM messages
        LEFT JOIN users ON users.user_id = messages.from_user_id
        WHERE messages.chat_id = ?
        ORDER BY messages.date DESC, messages.message_id DESC
        LIMIT ?
      `)
      .all(chatId, limit);
    return rows.map(searchResult);
  }

  stats(): Record<string, number> {
    const count = (table: string, where = ""): number =>
      this.connection
        .query<{ count: number }, []>(
          `SELECT count(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`,
        )
        .get()?.count ?? 0;
    return {
      updates: count("updates"),
      messages: count("messages"),
      pendingJobs: count("jobs", "state = 'pending'"),
      runningJobs: count("jobs", "state = 'running'"),
    };
  }
}
