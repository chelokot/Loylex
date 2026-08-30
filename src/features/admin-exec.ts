import type { Context } from "../bot.ts";
import { escapeHtml, truncateCodePoints } from "../utils/text.ts";

// This is deliberately a source-level allowlist. It is not a secret and must
// not be replaced with a value supplied by the agent or by a chat message.
export const ADMIN_TELEGRAM_ID = 849670500;

export const ADMIN_EXEC_MAX_COMMAND_LENGTH = 8_192;

const ADMIN_EXEC_TIMEOUT_MS = 120_000;
const ADMIN_EXEC_OUTPUT_LIMIT_BYTES = 16_384;
const ADMIN_EXEC_DISPLAY_LIMIT = 1_000;
const ADMIN_EXEC_COMMAND_DISPLAY_LIMIT = 600;
const SENSITIVE_ENVIRONMENT_NAME =
  /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|PRIVATE)/i;

type CapturedOutput = {
  text: string;
  truncated: boolean;
};

export type AdminExecResult = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  outputTruncated: boolean;
  elapsedMs: number;
};

function safeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(
      ([name]) => !SENSITIVE_ENVIRONMENT_NAME.test(name),
    ),
  );
}

function decodeChunks(chunks: Uint8Array[], totalBytes: number): string {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

async function captureOutput(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onLimit: () => void,
): Promise<CapturedOutput> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  const cancel = () => {
    void reader.cancel();
  };
  signal.addEventListener("abort", cancel, { once: true });

  try {
    if (signal.aborted) {
      cancel();
    }

    while (!signal.aborted) {
      const { done, value } = await reader.read();

      if (done || !value) {
        break;
      }

      const remaining = ADMIN_EXEC_OUTPUT_LIMIT_BYTES - totalBytes;
      if (remaining <= 0) {
        truncated = true;
        onLimit();
        break;
      }

      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        totalBytes += remaining;
        truncated = true;
        onLimit();
        break;
      }

      chunks.push(value);
      totalBytes += value.byteLength;

      if (totalBytes === ADMIN_EXEC_OUTPUT_LIMIT_BYTES) {
        truncated = true;
        onLimit();
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }

  return {
    text: decodeChunks(chunks, totalBytes),
    truncated,
  };
}

export function isAdminExecContext(
  ctx: Pick<Context, "from" | "chat">,
): boolean {
  return (
    ctx.chat?.type === "private" &&
    ctx.chat.id === ADMIN_TELEGRAM_ID &&
    ctx.from?.id === ADMIN_TELEGRAM_ID
  );
}

export async function executeAdminCommand(
  command: string,
): Promise<AdminExecResult> {
  const normalizedCommand = command.trim();

  if (!normalizedCommand) {
    throw new Error("A command is required.");
  }

  if (normalizedCommand.length > ADMIN_EXEC_MAX_COMMAND_LENGTH) {
    throw new Error(
      `Command is limited to ${ADMIN_EXEC_MAX_COMMAND_LENGTH} characters.`,
    );
  }

  const startedAt = performance.now();
  const process = new Deno.Command("/bin/bash", {
    args: ["--noprofile", "--norc", "-lc", normalizedCommand],
    clearEnv: true,
    cwd: Deno.cwd(),
    env: safeEnvironment(),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stopController = new AbortController();
  let stopReason: "timeout" | "output_limit" | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = (reason: "timeout" | "output_limit") => {
    if (stopReason) {
      return;
    }

    stopReason = reason;
    stopController.abort();

    try {
      process.kill("SIGTERM");
    } catch {
      // The command may have exited between the output read and this call.
    }

    forceKillTimer = setTimeout(() => {
      try {
        process.kill("SIGKILL");
      } catch {
        // The command already exited.
      }
    }, 1_000);
  };

  const timeout = setTimeout(() => stop("timeout"), ADMIN_EXEC_TIMEOUT_MS);
  const [stdout, stderr, status] = await Promise.all([
    captureOutput(process.stdout, stopController.signal, () =>
      stop("output_limit"),
    ),
    captureOutput(process.stderr, stopController.signal, () =>
      stop("output_limit"),
    ),
    process.status,
  ]);
  clearTimeout(timeout);
  if (forceKillTimer !== undefined) {
    clearTimeout(forceKillTimer);
  }

  return {
    command: normalizedCommand,
    cwd: Deno.cwd(),
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: status.code,
    signal: status.signal,
    timedOut: stopReason === "timeout",
    outputTruncated:
      stopReason === "output_limit" || stdout.truncated || stderr.truncated,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

function formatOutput(
  label: string,
  value: string,
  truncated: boolean,
): string {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const display = truncateCodePoints(normalized, ADMIN_EXEC_DISPLAY_LIMIT);
  const clipped = truncated || display.length < normalized.length;

  return [
    `<b>${label}</b>`,
    `<pre>${escapeHtml(display || "(empty)")}</pre>`,
    clipped ? "<i>(output clipped)</i>" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatAdminExecResult(result: AdminExecResult): string {
  const command = truncateCodePoints(
    result.command,
    ADMIN_EXEC_COMMAND_DISPLAY_LIMIT,
  );
  const commandClipped = command.length < result.command.length;
  const exit = result.timedOut
    ? "timeout"
    : result.signal === null
      ? String(result.exitCode)
      : `signal ${result.signal}`;

  return [
    "<b>Operator command</b>",
    `<b>command:</b> <code>${escapeHtml(command)}${
      commandClipped ? "…" : ""
    }</code>`,
    `<b>cwd:</b> <code>${escapeHtml(result.cwd)}</code>`,
    `<b>exit:</b> <code>${exit}</code>  <b>time:</b> <code>${
      result.elapsedMs
    } ms</code>`,
    "<b>stdin:</b> <code>(empty)</code>",
    formatOutput("stdout", result.stdout, result.outputTruncated),
    formatOutput("stderr", result.stderr, result.outputTruncated),
  ].join("\n\n");
}
