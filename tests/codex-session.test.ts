import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolActivityFromCodexItem } from "../src/agent/codex.ts";
import { CodexSessionExtensions } from "../src/agent/codex-session.ts";

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
    expect(
      toolActivityFromCodexItem(items[0] as Parameters<typeof toolActivityFromCodexItem>[0]),
    ).toBe("Searched for 'France Le Vigilant M51.3 test'");
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

test("passes a journal-only web search through the runner into Telegram work history", async () => {
  const { runCodex } = await import("../src/agent/codex.ts");
  const { workDocument } = await import("../src/gateway/presentation.ts");
  const home = await mkdtemp(join(tmpdir(), "loylex-session-run-"));
  try {
    const binary = join(home, "fake-codex");
    await writeFile(
      binary,
      `#!/usr/bin/env bun
import {mkdirSync,writeFileSync} from 'node:fs';
const directory=process.env.CODEX_HOME+'/sessions/2026/10/06';
mkdirSync(directory,{recursive:true});
writeFileSync(directory+'/rollout-test-thread-123.jsonl',JSON.stringify({
 timestamp:new Date().toISOString(),type:'event_msg',payload:{
 type:'item_completed',thread_id:'thread-123',item:{
 type:'Extension',kind:'web.search',id:'exec-search',query:'France M51.3'
 }}})+'\\n');
for(const event of [
 {type:'thread.started',thread_id:'thread-123'},
 {type:'item.completed',item:{type:'agent_message',text:'Done'}},
 {type:'turn.completed'}
]) console.log(JSON.stringify(event));
`,
      { mode: 0o700 },
    );
    const events: import("../src/shared/types.ts").AgentEvent[] = [];
    const result = await runCodex(
      {
        bridgeUrl: "",
        bridgeToken: "",
        codexBinary: binary,
        codexHome: home,
        model: "test",
        reasoningEffort: "low",
        serviceTier: "priority",
        repositoryPath: home,
        memoryPath: home,
        pollIntervalMs: 1000,
        maxConcurrentJobs: 1,
      },
      "test",
      null,
      async (event) => {
        events.push(event);
      },
    );
    expect(result.answer).toBe("Done");
    const tools = events.filter((event) => event.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(workDocument(`tool: ${tools[0]?.text}`)).toContain("France M51.3");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
