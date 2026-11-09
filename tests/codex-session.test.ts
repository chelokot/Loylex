import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSessionExtensions } from "../src/agent/codex-session.ts";
import { toolActivity } from "../src/agent/tool-activity.ts";

test("recovers omitted web Extension events once, without replaying old turns", async () => {
  const home = await mkdtemp(join(tmpdir(), "loylex-session-"));
  try {
    const directory = join(home, "sessions", "2026", "10", "06");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "rollout-test-thread-123.jsonl");
    const event = (timestamp: string, query: string, thread = "thread-123") =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "item_completed",
          thread_id: thread,
          item: { type: "Extension", kind: "web.search", id: "exec-web-1", query },
        },
      });
    await writeFile(path, `${event("2026-10-06T13:00:00Z", "old search")}\n`);
    const reader = new CodexSessionExtensions(home, Date.parse("2026-10-06T13:32:00Z"));
    await reader.skipExisting("thread-123");
    const record = event("2026-10-06T13:32:20Z", "France Le Vigilant M51.3 test");
    await appendFile(path, record.slice(0, 60));
    expect(await reader.read("thread-123")).toEqual([]);
    await appendFile(path, `${record.slice(60)}\n`);
    const items = await reader.read("thread-123");
    expect(items).toHaveLength(1);
    expect(toolActivity(items[0] as Parameters<typeof toolActivity>[0])).toBe(
      "Searched for 'France Le Vigilant M51.3 test'",
    );
    expect(await reader.read("thread-123")).toEqual([]);
    await appendFile(
      path,
      `malformed\n${event("2026-10-06T13:32:22Z", "other", "other-thread")}\n`,
    );
    expect(await reader.read("thread-123")).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
