import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoylexDatabase } from "../src/gateway/database.ts";
import { LeylobucksActivity, leylobucksIdleMs } from "../src/gateway/leylobucks-activity.ts";
import { LeylobucksCommands } from "../src/gateway/leylobucks-commands.ts";
import { LeylobucksMode } from "../src/gateway/leylobucks-mode.ts";
import type { TelegramMessage } from "../src/shared/types.ts";

const directories: string[] = [];
const databases: LoylexDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.connection.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function setup(path?: string) {
  if (!path) {
    const directory = mkdtempSync(join(tmpdir(), "loylex-bucks-activity-"));
    directories.push(directory);
    path = join(directory, "test.sqlite");
  }
  const database = new LoylexDatabase(path);
  databases.push(database);
  const activity = new LeylobucksActivity(database.connection);
  const mode = new LeylobucksMode(
    {
      isEnabled: (id) => database.isLeylobucksEnabled(id),
      setEnabled: (id, enabled) => database.setLeylobucksEnabled(id, enabled),
    },
    activity,
  );
  const responses: string[] = [];
  const commands = new LeylobucksCommands(database, mode, "loylex_bot", async (_, markdown) => {
    responses.push(markdown);
  });
  return { path, database, activity, mode, commands, responses };
}

function message(text: string): TelegramMessage {
  return {
    message_id: 1,
    date: 1,
    chat: { id: 7, type: "private" },
    text,
    from: { id: 7, first_name: "Test", is_bot: false },
  };
}

function idle(activity: LeylobucksActivity, id = 7) {
  activity.interact(id, Date.now() - leylobucksIdleMs - 1000);
}

describe("idle Loylebucks", () => {
  test("hides at 48 hours, independently of passive balance changes or visibility reads", () => {
    const { database, activity } = setup();
    database.testBumpLeylobucks(7, 1030);
    const now = Date.now();
    activity.interact(7, now);
    expect(activity.isVisible(7, now + leylobucksIdleMs - 1)).toBe(true);
    database.testBumpLeylobucks(7, 1);
    expect(activity.isVisible(7, now + leylobucksIdleMs)).toBe(false);
    expect(activity.isVisible(8, now + leylobucksIdleMs)).toBe(true);
    expect(database.leylobucksStatus(7).balance).toBe(1031);
  });

  test("persists auto hiding through restart and wakes on a balance command", async () => {
    const first = setup();
    idle(first.activity);
    expect(first.mode.isEnabled(7)).toBe(false);
    const restarted = setup(first.path);
    expect(restarted.mode.isEnabled(7)).toBe(false);
    expect(await restarted.commands.handle(message("/bucks"), 7)).toBe(true);
    expect(restarted.responses).toHaveLength(1);
    expect(restarted.mode.isEnabled(7)).toBe(true);
  });

  test("ordinary messages and commands addressed to another bot do not wake", async () => {
    const { activity, mode, commands } = setup();
    idle(activity);
    expect(await commands.handle(message("Привет"), 7)).toBe(false);
    expect(await commands.handle(message("/quiz@other_bot"), 7)).toBe(false);
    expect(mode.isEnabled(7)).toBe(false);
  });

  test("quiz commands, answer buttons and purchases wake auto-hidden accounts", async () => {
    const { database, activity, mode, commands } = setup();
    database.testBumpLeylobucks(7, 1030);
    idle(activity);
    await commands.handle(message("/quiz"), 7);
    expect(mode.isEnabled(7)).toBe(true);
    expect(database.leylobucksStatus(7).quiz?.questionIndex).toBe(0);
    idle(activity);
    expect(commands.quizAnswer(7, "A")).not.toBeNull();
    expect(mode.isEnabled(7)).toBe(true);
    expect(database.leylobucksStatus(7).quiz?.questionIndex).toBe(1);
    idle(activity);
    await commands.handle(message("/bucks buy 100"), 7);
    expect(mode.isEnabled(7)).toBe(true);
    expect(database.leylobucksStatus(7).balance).toBe(930);
  });

  test("manual off survives commands, buttons and restart; explicit on resets idle state", async () => {
    const first = setup();
    idle(first.activity);
    first.mode.isEnabled(7);
    first.mode.setEnabled(7, false);
    const { database, mode, commands, activity } = setup(first.path);
    await commands.handle(message("/bucks"), 7);
    await commands.handle(message("/quiz"), 7);
    expect(commands.quizAnswer(7, "A")).toBeNull();
    expect(mode.isEnabled(7)).toBe(false);
    expect(database.leylobucksStatus(7).quiz).toBeNull();
    // The gateway HTTP mode endpoint also uses the database setter directly.
    idle(activity);
    database.setLeylobucksEnabled(7, true);
    expect(mode.isEnabled(7)).toBe(true);
  });

  test("existing accounts seed inactivity once and retain it after passive updates", () => {
    const { database, path } = setup();
    database.setLeylobucksEnabled(7, true);
    database.connection.query("DELETE FROM leylobucks_activity WHERE user_id = 7").run();
    database.connection
      .query("UPDATE leylobucks_accounts SET updated_at = ? WHERE user_id = 7")
      .run(Date.now() - leylobucksIdleMs - 1);
    const migrated = setup(path);
    expect(migrated.mode.isEnabled(7)).toBe(false);
    database.testBumpLeylobucks(7, 1030);
    expect(setup(path).mode.isEnabled(7)).toBe(false);
  });
});
