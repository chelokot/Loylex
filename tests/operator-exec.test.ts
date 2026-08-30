import { afterEach, expect, test } from "bun:test";
import { executeOperatorCommand, formatOperatorExecResult } from "../src/agent/operator-exec.ts";
import { isOperatorExecContext, parseOperatorExecCommand } from "../src/shared/operator-exec.ts";
import type { TelegramMessage } from "../src/shared/types.ts";

const originalTestToken = process.env.ADMIN_EXEC_TEST_TOKEN;

afterEach(() => {
  if (originalTestToken === undefined) {
    delete process.env.ADMIN_EXEC_TEST_TOKEN;
  } else {
    process.env.ADMIN_EXEC_TEST_TOKEN = originalTestToken;
  }
});

function message(
  userId: number,
  chatId: number,
  chatType: "private" | "group",
  text: string,
): TelegramMessage {
  return {
    message_id: 1,
    date: 1,
    chat: { id: chatId, type: chatType },
    from: { id: userId, is_bot: false, first_name: "Operator" },
    text,
  };
}

test("operator exec requires the exact sender id and works in groups", () => {
  const authorized = message(426043802, -10042, "group", "/exec pwd");
  expect(isOperatorExecContext(authorized)).toBe(true);
  expect(parseOperatorExecCommand(authorized, "LoylexBot")).toEqual({
    authorized: true,
    command: "pwd",
  });
  expect(parseOperatorExecCommand(message(1, -10042, "group", "/exec pwd"))).toEqual({
    authorized: false,
    command: "",
  });
  expect(
    parseOperatorExecCommand(
      message(426043802, -10042, "group", "/exec@AnotherBot pwd"),
      "LoylexBot",
    ),
  ).toEqual({
    authorized: false,
    command: "",
  });
  expect(parseOperatorExecCommand(message(426043802, -10042, "group", "not exec"))).toBeNull();
});

test("operator exec captures stdout and stderr without secret environment values", async () => {
  process.env.ADMIN_EXEC_TEST_TOKEN = "must-not-be-inherited";
  const result = await executeOperatorCommand(
    `printf '%s' "\${ADMIN_EXEC_TEST_TOKEN:-missing}"; printf '%s' 'stderr' >&2`,
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("missing");
  expect(result.stderr).toBe("stderr");
  expect(result.timedOut).toBe(false);
});

test("operator exec output is escaped for Telegram Rich Markdown", () => {
  const result = formatOperatorExecResult({
    command: "printf '<danger>&'",
    cwd: "/workspace/Loylex",
    stdout: "<danger>&",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    outputTruncated: false,
    elapsedMs: 4,
  });

  expect(result).toContain("&lt;danger&gt;&amp;");
  expect(result).not.toContain("<danger>");
});
