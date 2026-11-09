import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoylexDatabase } from "../../src/gateway/database.ts";
import type { TelegramMessage } from "../../src/shared/types.ts";

const directories: string[] = [];

export function removeDatabases(): void {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

export function setup(): LoylexDatabase {
  return new LoylexDatabase(join(temporaryDirectory("loylex-db-"), "test.sqlite"));
}

export function message(id: number, text: string): TelegramMessage {
  return {
    message_id: id,
    date: 1_700_000_000 + id,
    chat: { id: -10042, type: "supergroup", title: "Test" },
    from: { id: 7, is_bot: false, first_name: "Andrii", username: "chelokot" },
    text,
  };
}

export function botMessage(id: number, text: string): TelegramMessage {
  return {
    message_id: id,
    date: 1_700_000_000 + id,
    chat: { id: -10042, type: "supergroup", title: "Test" },
    from: { id: 99, is_bot: true, first_name: "Loylex" },
    text,
  };
}

export function privateMessage(id: number, text: string): TelegramMessage {
  return {
    message_id: id,
    date: 1_700_000_000 + id,
    chat: { id: 42, type: "private" },
    from: { id: 7, is_bot: false, first_name: "Artem" },
    text,
  };
}

export function forwardedMessage(id: number, text: string): TelegramMessage {
  return {
    ...message(id, text),
    forward_origin: {
      type: "user",
      date: 1_700_000_500,
      sender_user: {
        id: 42,
        is_bot: false,
        first_name: "Chelokot",
        username: "chelokot",
      },
    },
  };
}
