import { expect, test } from "bun:test";
import { parseCodexUsage } from "../src/agent/codex.ts";
import { visibleTerminalCommand } from "../src/shared/terminal-command.ts";

test("parses the usage payload from a completed Codex turn", () => {
  expect(
    parseCodexUsage({
      type: "turn.completed",
      usage: {
        input_tokens: 120,
        cached_input_tokens: 80,
        cache_write_input_tokens: 4,
        output_tokens: 30,
        reasoning_output_tokens: 20,
        total_tokens: 150,
      },
    }),
  ).toEqual({
    inputTokens: 120,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 4,
    outputTokens: 30,
    reasoningOutputTokens: 20,
    totalTokens: 150,
  });
});

test("fills missing optional Codex usage counters from zero", () => {
  expect(parseCodexUsage({ usage: { input_tokens: 12, output_tokens: 3 } })).toEqual({
    inputTokens: 12,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 3,
    reasoningOutputTokens: 0,
    totalTokens: 15,
  });
});

test("ignores malformed or unrelated Codex events", () => {
  expect(parseCodexUsage({ type: "item.completed", item: { type: "agent_message" } })).toBeNull();
  expect(parseCodexUsage({ type: "turn.completed", usage: { input_tokens: -1 } })).toBeNull();
});

test("shows the command body instead of Codex's shell launcher", () => {
  expect(
    visibleTerminalCommand("/bin/bash -lc 'find skills -maxdepth 2 -name SKILL.md -print'"),
  ).toBe("find skills -maxdepth 2 -name SKILL.md -print");
  expect(visibleTerminalCommand(`/bin/bash -lc "printf '%s' hello"`)).toBe("printf '%s' hello");
  expect(visibleTerminalCommand(String.raw`/bin/bash -lc 'printf '\''%s'\'' hello'`)).toBe(
    "printf '%s' hello",
  );
});

test("preserves commands that are not a recognizable shell wrapper", () => {
  expect(visibleTerminalCommand("git status --short")).toBe("git status --short");
  expect(visibleTerminalCommand("/bin/bash -lc")).toBe("/bin/bash -lc");
  expect(visibleTerminalCommand("/usr/bin/python3 -c 'print(1)'")).toBe(
    "/usr/bin/python3 -c 'print(1)'",
  );
});
