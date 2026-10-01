import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessConversation, assessmentPrompt } from "../src/agent/assessment.ts";
import type { AgentConfig } from "../src/agent/config.ts";
import { isContextualAssessment, unavailableAssessment } from "../src/shared/assessment.ts";
import type { AgentJob } from "../src/shared/types.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const job: AgentJob = {
  id: 1,
  updateId: 1,
  chatId: -42,
  chatType: "supergroup",
  messageId: 12,
  messageThreadId: null,
  userId: 7,
  prompt: "Не меняй, всё правильно",
  resumeThreadId: "thread",
  context: "",
  assessmentContext: "Предлагают заменить реакцию бота.",
  replyContext: "Постоянное правило оставлено без изменений.",
  contextMode: "delta",
  attachments: [],
};

test("uses full scoring context and the explicit reply even on resumed turns", () => {
  const data = JSON.parse(assessmentPrompt(job).split("\n\n").at(-1) ?? "");
  expect(data).toEqual({
    currentMessage: job.prompt,
    recentContext: job.assessmentContext,
    replyTarget: job.replyContext,
  });
});

test("rejects malformed or unbounded monetary inputs", () => {
  for (const value of [
    null,
    { qualityScore: 101, reason: "x" },
    { qualityScore: 1.5, reason: "x" },
    { qualityScore: 70, reason: "" },
    { qualityScore: 70, reason: "x".repeat(501) },
  ])
    expect(isContextualAssessment(value)).toBe(false);
});

async function fakeConfig(source: string): Promise<AgentConfig> {
  const directory = await mkdtemp(join(tmpdir(), "loylex-assessment-test-"));
  directories.push(directory);
  const binary = join(directory, "codex");
  await writeFile(binary, `#!/usr/bin/env bun\n${source}`);
  await chmod(binary, 0o700);
  return {
    codexBinary: binary,
    codexHome: directory,
    repositoryPath: directory,
    model: "test",
    reasoningEffort: "low",
    serviceTier: "priority",
    bridgeUrl: "unused",
    bridgeToken: "unused",
    memoryPath: directory,
    pollIntervalMs: 1000,
    maxConcurrentJobs: 1,
  };
}

test("accepts structured output without giving conversation data executable arguments", async () => {
  const config = await fakeConfig(`
    if (!process.argv.includes("read-only") || !process.argv.includes("--ignore-user-config") || process.env.LOYLEX_BRIDGE_TOKEN) process.exit(3);
    if (process.argv.some(a => a.includes("Не меняй"))) process.exit(4);
    await new Response(Bun.stdin.stream()).text();
    console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({qualityScore:55,reason:"Уместное подтверждение."})}}));
  `);
  expect(await assessConversation(config, job, new AbortController().signal)).toEqual({
    qualityScore: 55,
    reason: "Уместное подтверждение.",
  });
});

test("a failed evaluator or unexpected tool event leaves the balance neutral", async () => {
  for (const source of [
    "process.exit(2)",
    "console.log('not-json')",
    'console.log(JSON.stringify({type:"item.started",item:{type:"command_execution",command:"ignored"}}))',
  ]) {
    const config = await fakeConfig(source);
    expect(await assessConversation(config, job, new AbortController().signal)).toEqual(
      unavailableAssessment,
    );
  }
});

test("cancellation and timeout terminate an evaluator and return neutral", async () => {
  const config = await fakeConfig("await Bun.sleep(10000)");
  expect(
    await assessConversation(config, job, new AbortController().signal, undefined, 50),
  ).toEqual(unavailableAssessment);
  const controller = new AbortController();
  controller.abort();
  expect(await assessConversation(config, job, controller.signal)).toEqual(unavailableAssessment);
});
