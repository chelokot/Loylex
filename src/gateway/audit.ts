import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { TelegramMessage, TelegramUpdate } from "../shared/types.ts";

type AuditEvent = "message" | "edited_message" | "channel_post" | "edited_channel_post";

export type InboundAuditRecord = {
  version: 1;
  received_at: string;
  update_id: number;
  event: AuditEvent;
  chat_id: number;
  message_id: number;
  message_thread_id: number | null;
  telegram_date: number;
  author_id: number | null;
  text: string | null;
};

type AuditedMessage = {
  event: AuditEvent;
  message: TelegramMessage;
};

const openFlags =
  constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function auditedMessage(update: TelegramUpdate): AuditedMessage | null {
  if (update.message) {
    return { event: "message", message: update.message };
  }
  if (update.edited_message) {
    return { event: "edited_message", message: update.edited_message };
  }
  if (update.channel_post) {
    return { event: "channel_post", message: update.channel_post };
  }
  if (update.edited_channel_post) {
    return { event: "edited_channel_post", message: update.edited_channel_post };
  }
  return null;
}

function record(
  update: TelegramUpdate,
  audited: AuditedMessage,
  receivedAt: string,
): InboundAuditRecord {
  const { message } = audited;
  return {
    version: 1,
    received_at: receivedAt,
    update_id: update.update_id,
    event: audited.event,
    chat_id: message.chat.id,
    message_id: message.message_id,
    message_thread_id: message.message_thread_id ?? null,
    telegram_date: message.date,
    author_id: message.from?.id ?? message.sender_chat?.id ?? null,
    text: message.text ?? message.caption ?? null,
  };
}

export class InboundAuditLog {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async assertReady(): Promise<void> {
    const handle = await this.openChecked();
    await handle.close();
  }

  append(update: TelegramUpdate): Promise<boolean> {
    const audited = auditedMessage(update);
    if (!audited) {
      return Promise.resolve(false);
    }

    const line = `${JSON.stringify(record(update, audited, this.clock()))}\n`;
    const write = this.writeQueue.then(() => this.writeLine(line));
    this.writeQueue = write.then(
      () => undefined,
      () => undefined,
    );
    return write.then(() => true);
  }

  private async openChecked() {
    const handle = await open(this.path, openFlags);
    try {
      if (!(await handle.stat()).isFile()) {
        throw new Error(`Inbound audit path is not a regular file: ${this.path}`);
      }
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async writeLine(line: string): Promise<void> {
    const handle = await this.openChecked();
    try {
      let remaining = new TextEncoder().encode(line);
      while (remaining.byteLength > 0) {
        const result = await handle.write(remaining);
        if (result.bytesWritten <= 0) {
          throw new Error("Inbound audit append made no progress");
        }
        remaining = remaining.subarray(result.bytesWritten);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
