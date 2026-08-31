import { Api, InputFile } from "../../vendor/telegram-bot-api/mod.mjs";
import type {
  JsonObject,
  JsonValue,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "../shared/types.ts";

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

function apiErrorDetails(error: unknown): { errorCode: number; message: string } {
  if (typeof error === "object" && error !== null) {
    const details = error as {
      description?: unknown;
      error_code?: unknown;
      status?: unknown;
    };
    const message =
      typeof details.description === "string"
        ? details.description
        : error instanceof Error
          ? error.message
          : String(error);
    const code = details.error_code ?? details.status;
    return {
      errorCode: typeof code === "number" ? code : 0,
      message,
    };
  }
  return { errorCode: 0, message: String(error) };
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
  readonly #api: Api;
  readonly #fileBaseUrl: string;

  constructor(token: string) {
    this.#api = new Api(token);
    this.#fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
  }

  private async invoke<T>(
    method: string,
    action: (signal: AbortSignal) => Promise<unknown>,
    timeoutMs = 60_000,
  ): Promise<T> {
    try {
      return (await action(AbortSignal.timeout(timeoutMs))) as T;
    } catch (error) {
      if (error instanceof TelegramApiError) {
        throw error;
      }
      const details = apiErrorDetails(error);
      throw new TelegramApiError(method, details.errorCode, details.message);
    }
  }

  getMe(): Promise<TelegramUser> {
    return this.invoke<TelegramUser>("getMe", (signal) => this.#api.getMe(signal));
  }

  getUpdates(offset: number, timeout: number): Promise<TelegramUpdate[]> {
    return this.invoke<TelegramUpdate[]>("getUpdates", (signal) =>
      this.#api.getUpdates(
        {
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
        },
        signal,
      ),
    );
  }

  deleteWebhook(body: JsonObject = {}): Promise<boolean> {
    return this.invoke<boolean>("deleteWebhook", (signal) => this.#api.deleteWebhook(body, signal));
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
    return this.invoke<TelegramMessage>("sendRichMessage", (signal) =>
      this.#api.sendRichMessage(chatId, body.rich_message as JsonObject, body, signal),
    );
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
    return this.invoke<boolean>("sendRichMessageDraft", (signal) =>
      this.#api.sendRichMessageDraft(
        chatId,
        options.draftId,
        body.rich_message as JsonObject,
        body,
        signal,
      ),
    );
  }

  async editRich(chatId: number, messageId: number, markdown: string): Promise<TelegramMessage> {
    try {
      return await this.invoke<TelegramMessage>("editMessageText", (signal) =>
        this.#api.editMessageText(chatId, messageId, { markdown }, {}, signal),
      );
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
      throw error;
    }
  }

  deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    return this.invoke<boolean>("deleteMessage", (signal) =>
      this.#api.deleteMessage(chatId, messageId, signal),
    );
  }

  sendTyping(chatId: number, threadId: number | null = null): Promise<boolean> {
    const body: JsonObject = {};
    if (threadId !== null) {
      body.message_thread_id = threadId;
    }
    return this.invoke<boolean>("sendChatAction", (signal) =>
      this.#api.sendChatAction(chatId, "typing", body, signal),
    );
  }

  setThinkingReaction(chatId: number, messageId: number): Promise<boolean> {
    return this.setMessageReaction(chatId, messageId, "🤔");
  }

  setMessageReaction(chatId: number, messageId: number, emoji: string): Promise<boolean> {
    return this.invoke<boolean>("setMessageReaction", (signal) =>
      this.#api.setMessageReaction(
        chatId,
        messageId,
        [{ type: "emoji", emoji }] as JsonValue[],
        {},
        signal,
      ),
    );
  }

  setCommands(): Promise<boolean> {
    return this.invoke<boolean>("setMyCommands", (signal) =>
      this.#api.setMyCommands(
        [
          { command: "start", description: "Как обратиться к Loylex" },
          { command: "help", description: "Возможности и синтаксис" },
          { command: "stop", description: "Остановить работу" },
          { command: "tasks", description: "Показать последние задачи" },
          { command: "resume", description: "Продолжить задачу по ID" },
          { command: "newchat", description: "Начать новый тред в личке" },
        ],
        {},
        signal,
      ),
    );
  }

  async download(fileId: string): Promise<Response> {
    const file = await this.invoke<{ file_path: string }>("getFile", (signal) =>
      this.#api.getFile(fileId, signal),
    );
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
  ): Promise<TelegramMessage> {
    return this.invoke<TelegramMessage>(
      "sendDocument",
      (signal) =>
        this.#api.sendDocument(
          chatId,
          new InputFile(file, filename),
          caption ? { caption: caption.slice(0, 1_024) } : {},
          signal,
        ),
      120_000,
    );
  }

  async sendMediaGroup(
    chatId: number,
    files: ReadonlyArray<Blob & { readonly name: string }>,
    caption: string | null,
  ): Promise<TelegramMessage[]> {
    const media = files.map((file, index) => ({
      type: mediaGroupType(file),
      media: new InputFile(file, file.name),
      ...(index === 0 && caption ? { caption: caption.slice(0, 1_024) } : {}),
    }));
    return this.invoke<TelegramMessage[]>(
      "sendMediaGroup",
      (signal) => this.#api.sendMediaGroup(chatId, media, {}, signal),
      120_000,
    );
  }
}
