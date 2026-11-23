import type { TelegramMessage } from "../shared/types.ts";
import type { GatewayConfig } from "./config.ts";
import type { LoylexDatabase } from "./database.ts";
import { body, json } from "./http-json.ts";
import {
  defaultReadQueryRows,
  isReadQueryParameters,
  maxReadQueryRows,
  ReadQueryError,
} from "./read-query.ts";
import { runReadQuery } from "./read-query-process.ts";

function importMessage(value: unknown): value is TelegramMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const message = value as { message_id?: unknown; date?: unknown; chat?: unknown };
  if (!Number.isSafeInteger(message.message_id) || !Number.isSafeInteger(message.date)) {
    return false;
  }
  if (typeof message.chat !== "object" || message.chat === null || Array.isArray(message.chat)) {
    return false;
  }
  const chat = message.chat as { id?: unknown; type?: unknown };
  return (
    Number.isSafeInteger(chat.id) &&
    (chat.type === "channel" ||
      chat.type === "group" ||
      chat.type === "private" ||
      chat.type === "supergroup")
  );
}

export async function archiveRoute(
  request: Request,
  url: URL,
  database: LoylexDatabase,
  config: GatewayConfig,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/v1/archive/search") {
    const query = url.searchParams.get("q")?.trim();
    if (!query) {
      return json({ error: "q is required" }, 400);
    }
    const chat = url.searchParams.get("chat");
    const chatId = chat === null ? null : Number(chat);
    if (chat !== null && (chat.trim() === "" || !Number.isSafeInteger(chatId))) {
      return json({ error: "chat must be a valid chat ID" }, 400);
    }
    const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    const limit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 100);
    const parsedOffset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
    if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
      return json({ error: "offset must be a non-negative integer" }, 400);
    }
    return json({
      results: database.search(query, chatId, limit, parsedOffset),
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/archive/query") {
    const payload = await body<{
      sql?: unknown;
      params?: unknown;
      maxRows?: unknown;
    }>(request);
    if (typeof payload.sql !== "string" || payload.sql.trim() === "") {
      return json({ error: "sql is required" }, 400);
    }
    if (payload.params !== undefined && !isReadQueryParameters(payload.params)) {
      return json({ error: "params must be an array or object of string, number, or null" }, 400);
    }
    const maxRows = payload.maxRows ?? defaultReadQueryRows;
    if (
      typeof maxRows !== "number" ||
      !Number.isSafeInteger(maxRows) ||
      maxRows < 1 ||
      maxRows > maxReadQueryRows
    ) {
      return json({ error: `maxRows must be an integer from 1 to ${maxReadQueryRows}` }, 400);
    }
    try {
      return json(
        await runReadQuery({
          databasePath: config.databasePath,
          sql: payload.sql,
          params: payload.params === undefined ? [] : payload.params,
          maxRows,
        }),
      );
    } catch (error) {
      if (error instanceof ReadQueryError) {
        return json({ error: error.message }, 400);
      }
      throw error;
    }
  }

  if (request.method === "GET" && url.pathname === "/v1/archive/media") {
    const chat = url.searchParams.get("chat");
    const chatId = chat === null ? Number.NaN : Number(chat);
    if (!chat || !Number.isSafeInteger(chatId)) {
      return json({ error: "chat must be a valid chat ID" }, 400);
    }
    const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    const limit = Number.isNaN(parsedLimit) ? 100 : Math.min(Math.max(parsedLimit, 1), 1000);
    return json({ results: database.archivedMedia(chatId, limit) });
  }

  if (request.method === "GET" && url.pathname === "/v1/archive/message") {
    const chat = url.searchParams.get("chat");
    const message = url.searchParams.get("message");
    const chatId = chat === null ? Number.NaN : Number(chat);
    const messageId = message === null ? Number.NaN : Number(message);
    if (!chat || !Number.isSafeInteger(chatId) || !message || !Number.isSafeInteger(messageId)) {
      return json({ error: "chat and message must be valid integer IDs" }, 400);
    }
    const result = database.archivedMessage(chatId, messageId);
    return result === null ? json({ error: "message not found" }, 404) : json(result);
  }

  if (request.method === "GET" && url.pathname === "/v1/archive/messages") {
    const chat = url.searchParams.get("chat");
    const chatId = chat === null ? Number.NaN : Number(chat);
    if (!chat || !Number.isSafeInteger(chatId)) {
      return json({ error: "chat must be a valid chat ID" }, 400);
    }
    const parseBound = (name: string): number | null | "invalid" => {
      const value = url.searchParams.get(name);
      if (value === null || value === "") {
        return null;
      }
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : "invalid";
    };
    const after = parseBound("after");
    const before = parseBound("before");
    if (after === "invalid" || before === "invalid") {
      return json({ error: "after and before must be valid integer message IDs" }, 400);
    }
    const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    const limit = Number.isNaN(parsedLimit) ? 100 : Math.min(Math.max(parsedLimit, 1), 500);
    return json({ results: database.archivedMessages(chatId, after, before, limit) });
  }

  if (request.method === "POST" && url.pathname === "/v1/archive/import") {
    const payload = await body<{ messages?: unknown }>(request);
    if (
      !Array.isArray(payload.messages) ||
      payload.messages.length === 0 ||
      payload.messages.length > 250 ||
      !payload.messages.every(importMessage)
    ) {
      return json({ error: "messages must contain 1-250 valid Telegram messages" }, 400);
    }
    const chatIds = new Set(payload.messages.map((message) => message.chat.id));
    const chatId = payload.messages[0]?.chat.id;
    if (chatIds.size !== 1 || chatId === undefined || !database.chatExists(chatId)) {
      return json({ error: "unknown or mixed chat" }, 403);
    }
    return json({ imported: database.archiveExportMessages(payload.messages), chatId });
  }

  if (request.method === "GET" && url.pathname === "/v1/archive/recent") {
    const chat = url.searchParams.get("chat");
    const chatId = chat === null ? Number.NaN : Number(chat);
    if (!chat || !Number.isSafeInteger(chatId)) {
      return json({ error: "chat must be a valid chat ID" }, 400);
    }
    const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "500", 10);
    const limit = Number.isNaN(parsedLimit) ? 500 : Math.min(Math.max(parsedLimit, 1), 500);
    return json({ results: database.recent(chatId, limit) });
  }

  return null;
}
