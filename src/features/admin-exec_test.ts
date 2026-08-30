import { strictEqual } from "node:assert";
import type { Context } from "../bot.ts";
import {
  executeAdminCommand,
  formatAdminExecResult,
  isAdminExecContext,
} from "./admin-exec.ts";

function context(
  userId: number,
  chatId: number,
  chatType: "private" | "group",
): Context {
  return {
    from: { id: userId },
    chat: { id: chatId, type: chatType },
  } as unknown as Context;
}

Deno.test("operator exec requires the hardcoded private chat and user id", () => {
  strictEqual(
    isAdminExecContext(context(849670500, 849670500, "private")),
    true,
  );
  strictEqual(isAdminExecContext(context(1, 849670500, "private")), false);
  strictEqual(isAdminExecContext(context(849670500, 1, "private")), false);
  strictEqual(
    isAdminExecContext(context(849670500, 849670500, "group")),
    false,
  );
});

Deno.test("operator exec captures stdout and stderr without secret environment values", async () => {
  Deno.env.set("ADMIN_EXEC_TEST_TOKEN", "must-not-be-inherited");

  try {
    const result = await executeAdminCommand(
      `printf '%s' "\${ADMIN_EXEC_TEST_TOKEN:-missing}"; printf '%s' 'stderr' >&2`,
    );

    strictEqual(result.exitCode, 0);
    strictEqual(result.signal, null);
    strictEqual(result.stdout, "missing");
    strictEqual(result.stderr, "stderr");
    strictEqual(result.timedOut, false);
  } finally {
    Deno.env.delete("ADMIN_EXEC_TEST_TOKEN");
  }
});

Deno.test("operator exec output is escaped for Telegram HTML", () => {
  const message = formatAdminExecResult({
    command: "printf '<danger>&'",
    cwd: "/app",
    stdout: "<danger>&",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    elapsedMs: 4,
  });

  strictEqual(message.includes("&lt;danger&gt;&amp;"), true);
  strictEqual(message.includes("<danger>"), false);
});
