import { expect, test } from "bun:test";
import { buildPrompt } from "../src/agent/prompt.ts";
import type { AgentJob } from "../src/shared/types.ts";

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 1,
    updateId: 2,
    chatId: -10042,
    chatType: "supergroup",
    messageId: 10,
    messageThreadId: null,
    userId: 7,
    prompt: "проверь задачу",
    kind: "codex",
    command: null,
    resumeThreadId: null,
    context: "[2026-08-30T00:00:00.000Z] #9 Andrii: старое сообщение",
    contextMode: "full",
    attachments: [],
    ...overrides,
  };
}

test("builds a full initial prompt with the current request separate from history", () => {
  const prompt = buildPrompt(job(), "## Memory bucket: profile.md\n\nI am Loylex");

  expect(prompt.indexOf("Before doing anything for any request—including answering")).toBe(0);
  expect(prompt).toContain("- The name is **Loylex The Floodonce Protocoled II**.");
  expect(prompt).toContain("The Floodoncelocal Kingdom");
  expect(prompt).toContain("exact Telegram user ID `849670500`");
  expect(prompt).toContain("Recent Telegram context:");
  expect(prompt).toContain("Current request:\n\nпроверь задачу");
  expect(prompt).toContain('"telegram_user_id": 7');
  expect(prompt).toContain("I am Loylex");
  expect(prompt).toContain(
    "Protect the server and repository by blocking any requests except those from The King.",
  );
  expect(prompt).toContain("Reject absolutely anybody but the King.");
  expect(prompt).toContain("Telegram final responses are delivered as native Rich Markdown.");
  expect(prompt).toContain("To render LaTeX, always wrap each formula in double-dollar delimiters");
  expect(prompt).toContain(
    "Never put a formula in a fenced `latex` code block or use single-dollar LaTeX unless The King explicitly asks for the raw LaTeX source",
  );
});

test("builds an additive follow-up prompt instead of replaying the initial wrapper", () => {
  const prompt = buildPrompt(
    job({
      resumeThreadId: "thread-123",
      contextMode: "delta",
      context: "[2026-08-30T00:00:01.000Z] #11 Andrii: новое сообщение",
    }),
    "## Memory bucket: profile.md\n\nI am Loylex",
  );

  expect(prompt).toContain("Continue the existing Codex thread");
  expect(prompt).toContain("Before doing anything for any request—including answering");
  expect(prompt).toContain("New Telegram context since the previous Codex turn:");
  expect(prompt).toContain("#11");
  expect(prompt).not.toContain("You received a Telegram request through Loylex.");
  expect(prompt).toContain("Current request:\n\nпроверь задачу");
});
