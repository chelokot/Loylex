import {
  isJsonObject,
  isTelegramApiFieldName,
  isTelegramApiMethod,
  telegramApiMaxFileBytes,
  telegramApiMaxFileCount,
  telegramApiMaxTotalFileBytes,
} from "../shared/telegram-api.ts";
import type { ApprovalClient } from "./approvals.ts";
import type { LoylexDatabase } from "./database.ts";
import { body, json } from "./http-json.ts";
import type { TelegramClient } from "./telegram.ts";

function optionalPositiveInteger(value: string | File | null): number | undefined | null {
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function telegramRoute(
  request: Request,
  url: URL,
  database: LoylexDatabase,
  telegram: TelegramClient,
  approvals: ApprovalClient | null,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/v1/media") {
    const fileId = url.searchParams.get("file_id");
    if (!fileId) {
      return json({ error: "file_id is required" }, 400);
    }
    const downloaded = await telegram.download(fileId);
    return new Response(downloaded.body, {
      headers: {
        "content-type": downloaded.headers.get("content-type") ?? "application/octet-stream",
      },
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/telegram/upload") {
    const form = await request.formData();
    const chatId = Number(form.get("chat_id"));
    const file = form.get("file");
    const caption = form.get("caption");
    const replyTo = optionalPositiveInteger(form.get("reply_to"));
    const threadId = optionalPositiveInteger(form.get("thread_id"));
    if (!Number.isSafeInteger(chatId) || !database.chatExists(chatId)) {
      return json({ error: "unknown chat" }, 403);
    }
    if (replyTo === null || threadId === null) {
      return json({ error: "reply_to and thread_id must be positive integer IDs" }, 400);
    }
    if (!(file instanceof File)) {
      return json({ error: "file is required" }, 400);
    }
    const message = await telegram.sendDocument(
      chatId,
      file,
      file.name,
      typeof caption === "string" ? caption : null,
      {
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(threadId === undefined ? {} : { threadId }),
      },
    );
    return json({ chatId: message.chat.id, messageId: message.message_id });
  }

  if (request.method === "POST" && url.pathname === "/v1/telegram/upload-animation") {
    const form = await request.formData();
    const chatId = Number(form.get("chat_id"));
    const file = form.get("file");
    const caption = form.get("caption");
    const replyTo = optionalPositiveInteger(form.get("reply_to"));
    const threadId = optionalPositiveInteger(form.get("thread_id"));
    if (!Number.isSafeInteger(chatId) || !database.chatExists(chatId)) {
      return json({ error: "unknown chat" }, 403);
    }
    if (replyTo === null || threadId === null) {
      return json({ error: "reply_to and thread_id must be positive integer IDs" }, 400);
    }
    if (!(file instanceof File)) {
      return json({ error: "file is required" }, 400);
    }
    const message = await telegram.sendAnimation(
      chatId,
      file,
      file.name,
      typeof caption === "string" ? caption : null,
      {
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(threadId === undefined ? {} : { threadId }),
      },
    );
    return json({ chatId: message.chat.id, messageId: message.message_id });
  }

  if (request.method === "POST" && url.pathname === "/v1/telegram/upload-voice") {
    const form = await request.formData();
    const chatId = Number(form.get("chat_id"));
    const file = form.get("file");
    const caption = form.get("caption");
    const replyTo = optionalPositiveInteger(form.get("reply_to"));
    const threadId = optionalPositiveInteger(form.get("thread_id"));
    if (!Number.isSafeInteger(chatId) || !database.chatExists(chatId)) {
      return json({ error: "unknown chat" }, 403);
    }
    if (replyTo === null || threadId === null) {
      return json({ error: "reply_to and thread_id must be positive integer IDs" }, 400);
    }
    if (!(file instanceof File)) {
      return json({ error: "file is required" }, 400);
    }
    const message = await telegram.sendVoice(
      chatId,
      file,
      file.name,
      typeof caption === "string" ? caption : null,
      {
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(threadId === undefined ? {} : { threadId }),
      },
    );
    return json({ chatId: message.chat.id, messageId: message.message_id });
  }

  if (request.method === "POST" && url.pathname === "/v1/telegram/upload-album") {
    const form = await request.formData();
    const chatId = Number(form.get("chat_id"));
    const files = form.getAll("file").filter((value) => value instanceof File) as Array<
      Blob & { readonly name: string }
    >;
    const caption = form.get("caption");
    if (!Number.isSafeInteger(chatId) || !database.chatExists(chatId)) {
      return json({ error: "unknown chat" }, 403);
    }
    if (files.length < 2 || files.length > 10) {
      return json({ error: "album must contain 2-10 files" }, 400);
    }
    const messages = await telegram.sendMediaGroup(
      chatId,
      files,
      typeof caption === "string" ? caption : null,
    );
    return json({ chatId, messageIds: messages.map((message) => message.message_id) });
  }

  if (request.method === "POST" && url.pathname === "/v1/telegram/send") {
    const payload = await body<{
      chatId: number;
      markdown: string;
      replyTo?: number;
      threadId?: number;
    }>(request);
    if (!database.chatExists(payload.chatId)) {
      return json({ error: "unknown chat" }, 403);
    }
    const message = await telegram.sendRich(payload.chatId, payload.markdown, {
      ...(payload.replyTo === undefined ? {} : { replyTo: payload.replyTo }),
      ...(payload.threadId === undefined ? {} : { threadId: payload.threadId }),
    });
    return json({ chatId: message.chat.id, messageId: message.message_id });
  }

  if (request.method === "POST" && url.pathname === "/v1/telegram/forward") {
    const payload = await body<{
      chatId?: number;
      sourceChatId?: number;
      messageId?: number;
    }>(request);
    if (
      typeof payload.chatId !== "number" ||
      typeof payload.sourceChatId !== "number" ||
      typeof payload.messageId !== "number" ||
      !Number.isSafeInteger(payload.chatId) ||
      !Number.isSafeInteger(payload.sourceChatId) ||
      !Number.isSafeInteger(payload.messageId) ||
      payload.messageId <= 0
    ) {
      return json({ error: "chatId, sourceChatId and messageId must be valid integer IDs" }, 400);
    }
    if (!database.chatExists(payload.sourceChatId)) {
      return json({ error: "unknown source chat" }, 403);
    }
    const message = await telegram.forwardMessage(
      payload.chatId,
      payload.sourceChatId,
      payload.messageId,
    );
    return json({ chatId: message.chat.id, messageId: message.message_id });
  }

  if (request.method === "POST" && url.pathname === "/v1/telegram/copy") {
    const payload = await body<{
      chatId?: number;
      sourceChatId?: number;
      messageId?: number;
    }>(request);
    if (
      typeof payload.chatId !== "number" ||
      typeof payload.sourceChatId !== "number" ||
      typeof payload.messageId !== "number" ||
      !Number.isSafeInteger(payload.chatId) ||
      !Number.isSafeInteger(payload.sourceChatId) ||
      !Number.isSafeInteger(payload.messageId) ||
      payload.messageId <= 0
    ) {
      return json({ error: "chatId, sourceChatId and messageId must be valid integer IDs" }, 400);
    }
    if (!database.chatExists(payload.sourceChatId)) {
      return json({ error: "unknown source chat" }, 403);
    }
    const messageId = await telegram.copyMessage(
      payload.chatId,
      payload.sourceChatId,
      payload.messageId,
    );
    return json({ chatId: payload.chatId, messageId });
  }

  if (request.method === "POST" && url.pathname === "/v1/telegram/api") {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const method = form.get("method");
      const rawParameters = form.get("params");
      if (!isTelegramApiMethod(method) || typeof rawParameters !== "string") {
        return json({ error: "method and params are required" }, 400);
      }
      let parameters: unknown;
      try {
        parameters = JSON.parse(rawParameters);
      } catch {
        return json({ error: "params must be valid JSON" }, 400);
      }
      if (!isJsonObject(parameters)) {
        return json({ error: "params must be a JSON object" }, 400);
      }
      const files: Array<{ field: string; file: File }> = [];
      let totalBytes = 0;
      for (const [field, value] of form.entries()) {
        if (field === "method" || field === "params") {
          continue;
        }
        if (!isTelegramApiFieldName(field) || !(value instanceof File)) {
          return json({ error: "file fields must be named files" }, 400);
        }
        if (files.some((entry) => entry.field === field)) {
          return json({ error: `file field ${field} was provided more than once` }, 400);
        }
        if (value.size > telegramApiMaxFileBytes) {
          return json({ error: `file ${field} exceeds ${telegramApiMaxFileBytes} bytes` }, 413);
        }
        totalBytes += value.size;
        if (totalBytes > telegramApiMaxTotalFileBytes) {
          return json(
            { error: `files exceed ${telegramApiMaxTotalFileBytes} bytes in total` },
            413,
          );
        }
        files.push({ field, file: value });
      }
      if (files.length === 0 || files.length > telegramApiMaxFileCount) {
        return json(
          { error: `multipart requests must contain 1-${telegramApiMaxFileCount} files` },
          400,
        );
      }
      await approvals?.guard(method, parameters);
      const result = await telegram.callMultipart(method, parameters, files);
      return json({ method, result });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "request body must be valid JSON" }, 400);
    }
    if (!isJsonObject(payload) || !isTelegramApiMethod(payload.method)) {
      return json({ error: "method must be a valid Telegram API method" }, 400);
    }
    const parameters = payload.params === undefined ? {} : payload.params;
    if (!isJsonObject(parameters)) {
      return json({ error: "params must be a JSON object" }, 400);
    }
    await approvals?.guard(payload.method, parameters);
    const result = await telegram.call(payload.method, parameters);
    return json({ method: payload.method, result });
  }

  if (request.method === "POST" && url.pathname === "/v1/telegram/edit-caption") {
    const payload = await body<{
      chatId?: number;
      messageId?: number;
      caption?: string;
    }>(request);
    if (
      typeof payload.chatId !== "number" ||
      typeof payload.messageId !== "number" ||
      typeof payload.caption !== "string" ||
      !Number.isSafeInteger(payload.chatId) ||
      !Number.isSafeInteger(payload.messageId) ||
      payload.messageId <= 0
    ) {
      return json(
        {
          error: "chatId and messageId must be valid integer IDs and caption must be a string",
        },
        400,
      );
    }
    if (!database.chatExists(payload.chatId)) {
      return json({ error: "unknown chat" }, 403);
    }
    await approvals?.guard("editMessageCaption", {
      chat_id: payload.chatId,
      message_id: payload.messageId,
    });
    await telegram.editMessageCaption(payload.chatId, payload.messageId, payload.caption);
    return json({ chatId: payload.chatId, messageId: payload.messageId });
  }

  if (request.method === "POST" && url.pathname === "/v1/telegram/delete") {
    const payload = await body<{ chatId?: number; messageId?: number }>(request);
    if (
      typeof payload.chatId !== "number" ||
      typeof payload.messageId !== "number" ||
      !Number.isSafeInteger(payload.chatId) ||
      !Number.isSafeInteger(payload.messageId) ||
      payload.messageId <= 0
    ) {
      return json({ error: "chatId and messageId must be valid integer IDs" }, 400);
    }
    if (!database.chatExists(payload.chatId)) {
      return json({ error: "unknown chat" }, 403);
    }
    await approvals?.guard("deleteMessage", {
      chat_id: payload.chatId,
      message_id: payload.messageId,
    });
    const deleted = await telegram.deleteMessage(payload.chatId, payload.messageId);
    return json({
      chatId: payload.chatId,
      messageId: payload.messageId,
      deleted,
    });
  }

  return null;
}
