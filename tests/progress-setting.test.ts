import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoylexDatabase } from "../src/gateway/database.ts";
import { isProgressCommand } from "../src/gateway/progress-command.ts";
import type { TelegramMessage } from "../src/shared/types.ts";

test("progress toggles independently and persists across reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "loylex-progress-"));
  const path = join(directory, "test.sqlite");
  let db = new LoylexDatabase(path);
  try {
    expect(db.progressEnabled(1)).toBe(true);
    expect(db.toggleProgress(1)).toBe(false);
    expect(db.progressEnabled(2)).toBe(true);
    db.close();
    db = new LoylexDatabase(path);
    expect(db.progressEnabled(1)).toBe(false);
    expect(db.toggleProgress(1)).toBe(true);
    expect(db.progressEnabled(1)).toBe(true);
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});

test("progress command matches only this bot and takes no arguments", () => {
  const message = (text: string) => ({ text }) as TelegramMessage;
  expect(isProgressCommand(message("/progress"))).toBe(true);
  expect(isProgressCommand(message("/progress@LoylexBot"), "loylexbot")).toBe(true);
  expect(isProgressCommand(message("/progress@other"), "loylexbot")).toBe(false);
  expect(isProgressCommand(message("/progress extra"))).toBe(false);
});
