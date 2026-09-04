import type {
  JsonObject,
  JsonValue,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "../shared/types.ts";

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
};

const videoExtensions = new Set([
  "3gp",
  "avi",
  "gif",
  "m4v",
  "mkv",
  "mov",
  "mp4",
  "mpeg",
  "mpg",
  "ogv",
  "webm",
]);

function mediaGroupType(file: Blob & { readonly name: string }): "photo" | "video" {
  if (file.type.toLowerCase().startsWith("video/")) {
    return "video";
  }
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  return videoExtensions.has(extension) ? "video" : "photo";
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = "TelegramApiError";
  }
}

export class TelegramClient {
  readonly #baseUrl: string;
  readonly #fileBaseUrl: string;

  constructor(token: string) {
    this.#baseUrl = `https://api.telegram.org/bot${token}`;
    this.#fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
  }

  async call<T>(method: string, body: JsonObject = {}): Promise<T> {
    const response = await fetch(`${this.#baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !payload.ok || payload.result === undefined) {
      throw new TelegramApiError(
        method,
        payload.error_code ?? response.status,
        payload.description ?? response.statusText,
      );
    }
    return payload.result;
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe");
  }

  getUpdates(offset: number, timeout: number): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout,
      allowed_updates: [
        "message",
        "edited_message",
        "channel_post",
        "edited_channel_post",
        "business_connection",
        "business_message",
        "edited_business_message",
        "deleted_business_messages",
        "guest_message",
        "message_reaction",
        "message_reaction_count",
        "inline_query",
        "chosen_inline_result",
        "callback_query",
        "shipping_query",
        "pre_checkout_query",
        "purchased_paid_media",
        "poll",
        "poll_answer",
        "my_chat_member",
        "chat_member",
        "chat_join_request",
        "chat_boost",
        "removed_chat_boost",
        "managed_bot",
        "subscription",
        "stopped_message_generation",
      ],
    });
  }

  async sendRich(
    chatId: number,
    markdown: string,
    options: {
      replyTo?: number;
      threadId?: number | null;
      disableLinkPreview?: boolean;
    } = {},
  ): Promise<TelegramMessage> {
    const body: JsonObject = {
      chat_id: chatId,
      rich_message: { markdown },
    };
    if (options.replyTo !== undefined) {
      body.reply_parameters = { message_id: options.replyTo, allow_sending_without_reply: true };
    }
    if (options.threadId !== undefined && options.threadId !== null) {
      body.message_thread_id = options.threadId;
    }
    if (options.disableLinkPreview) {
      body.link_preview_options = { is_disabled: true };
    }
    return this.call<TelegramMessage>("sendRichMessage", body);
  }

  sendRichMessageDraft(
    chatId: number,
    markdown: string,
    options: { draftId: number; threadId?: number | null; canStop?: boolean },
  ): Promise<boolean> {
    const body: JsonObject = {
      chat_id: chatId,
      draft_id: options.draftId,
      rich_message: { markdown },
    };
    if (options.threadId !== undefined && options.threadId !== null) {
      body.message_thread_id = options.threadId;
    }
    if (options.canStop) {
      body.can_stop = true;
    }
    return this.call<boolean>("sendRichMessageDraft", body);
  }

  async editRich(
    chatId: number,
    messageId: number,
    markdown: string,
  ): Promise<TelegramMessage | null> {
    try {
      return await this.call<TelegramMessage>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        rich_message: { markdown },
      });
    } catch (error) {
      if (
        error instanceof TelegramApiError &&
        error.errorCode === 400 &&
        /message is not modified/i.test(error.message)
      ) {
        // Telegram treats an idempotent edit as an error. The requested state is already live,
        // so keep the job successful and return the edited message reference to the caller.
        return {
          message_id: messageId,
          date: Math.floor(Date.now() / 1_000),
          chat: { id: chatId, type: "private" },
        };
      }
      if (
        error instanceof TelegramApiError &&
        error.errorCode === 400 &&
        /message to edit not found/i.test(error.message)
      ) {
        return null;
      }
      throw error;
    }
  }

  async deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    try {
      return await this.call<boolean>("deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch (error) {
      if (
        error instanceof TelegramApiError &&
        error.errorCode === 400 &&
        /message to delete not found/i.test(error.message)
      ) {
        return true;
      }
      throw error;
    }
  }

  sendTyping(chatId: number, threadId: number | null = null): Promise<boolean> {
    const body: JsonObject = { chat_id: chatId, action: "typing" };
    if (threadId !== null) {
      body.message_thread_id = threadId;
    }
    return this.call<boolean>("sendChatAction", body);
  }

  setThinkingReaction(chatId: number, messageId: number): Promise<boolean> {
    return this.setMessageReaction(chatId, messageId, "🤔");
  }

  setMessageReaction(chatId: number, messageId: number, emoji: string): Promise<boolean> {
    return this.call<boolean>("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }] as JsonValue[],
    });
  }

  setCommands(): Promise<boolean> {
    return this.call<boolean>("setMyCommands", {
      commands: [
        { command: "start", description: "Как обратиться к Loylex" },
        { command: "help", description: "Возможности и синтаксис" },
        { command: "stop", description: "Остановить работу" },
        { command: "tasks", description: "Показать последние задачи" },
        { command: "resume", description: "Продолжить задачу по ID" },
        { command: "newchat", description: "Начать новый тред в личке" },
      ] as JsonValue[],
    });
  }

  async download(fileId: string): Promise<Response> {
    const file = await this.call<{ file_path: string }>("getFile", { file_id: fileId });
    const response = await fetch(`${this.#fileBaseUrl}/${file.file_path}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Telegram file download failed with ${response.status}`);
    }
    return response;
  }

  async sendDocument(
    chatId: number,
    file: Blob,
    filename: string,
    caption: string | null,
    options: { replyTo?: number; threadId?: number | null } = {},
  ): Promise<TelegramMessage> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("document", file, filename);
    if (caption) {
      form.set("caption", caption.slice(0, 1_024));
    }
    if (options.replyTo !== undefined) {
      form.set(
        "reply_parameters",
        JSON.stringify({ message_id: options.replyTo, allow_sending_without_reply: true }),
      );
    }
    if (options.threadId !== undefined && options.threadId !== null) {
      form.set("message_thread_id", String(options.threadId));
    }
    const response = await fetch(`${this.#baseUrl}/sendDocument`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const payload = (await response.json()) as TelegramResponse<TelegramMessage>;
    if (!response.ok || !payload.ok || !payload.result) {
      throw new TelegramApiError(
        "sendDocument",
        payload.error_code ?? response.status,
        payload.description ?? response.statusText,
      );
    }
    return payload.result;
  }

  async sendMediaGroup(
    chatId: number,
    files: ReadonlyArray<Blob & { readonly name: string }>,
    caption: string | null,
  ): Promise<TelegramMessage[]> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set(
      "media",
      JSON.stringify(
        files.map((file, index) => ({
          type: mediaGroupType(file),
          media: `attach://file${index}`,
          ...(index === 0 && caption ? { caption: caption.slice(0, 1_024) } : {}),
        })),
      ),
    );
    files.forEach((file, index) => {
      form.set(`file${index}`, file, file.name);
    });
    const response = await fetch(`${this.#baseUrl}/sendMediaGroup`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const payload = (await response.json()) as TelegramResponse<TelegramMessage[]>;
    if (!response.ok || !payload.ok || !payload.result) {
      throw new TelegramApiError(
        "sendMediaGroup",
        payload.error_code ?? response.status,
        payload.description ?? response.statusText,
      );
    }
    return payload.result;
  }
}
