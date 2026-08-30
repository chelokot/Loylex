import { ADMIN_EXEC_MAX_COMMAND_LENGTH } from "../shared/operator-exec.ts";

const ADMIN_EXEC_TIMEOUT_MS = 120_000;
const ADMIN_EXEC_OUTPUT_LIMIT_BYTES = 16_384;
const ADMIN_EXEC_DISPLAY_LIMIT = 4_000;
const ADMIN_EXEC_COMMAND_DISPLAY_LIMIT = 600;
const SENSITIVE_ENVIRONMENT_NAME = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|PRIVATE)/i;
const SAFE_SECRET_FILE_PATH = /^\/run\/secrets\//;

type CapturedOutput = {
  text: string;
  truncated: boolean;
};

export type OperatorExecResult = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  outputTruncated: boolean;
  elapsedMs: number;
};

function safeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      const [name, value] = entry;
      if (value === undefined) {
        return false;
      }
      return (
        !SENSITIVE_ENVIRONMENT_NAME.test(name) ||
        (name.endsWith("_FILE") && SAFE_SECRET_FILE_PATH.test(value))
      );
    }),
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
  const cancel = (): void => {
    void reader.cancel();
  };
  signal.addEventListener("abort", cancel, { once: true });

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      const remaining = ADMIN_EXEC_OUTPUT_LIMIT_BYTES - totalBytes;
      if (value.byteLength >= remaining) {
        if (remaining > 0) {
          chunks.push(value.slice(0, remaining));
          totalBytes += remaining;
        }
        truncated = true;
        onLimit();
        break;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }

  return { text: decodeChunks(chunks, totalBytes), truncated };
}

export async function executeOperatorCommand(
  command: string,
  cwd = process.cwd(),
): Promise<OperatorExecResult> {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    throw new Error("A command is required.");
  }
  if (normalizedCommand.length > ADMIN_EXEC_MAX_COMMAND_LENGTH) {
    throw new Error(`Command is limited to ${ADMIN_EXEC_MAX_COMMAND_LENGTH} characters.`);
  }

  const startedAt = performance.now();
  const stopController = new AbortController();
  let stopReason: "timeout" | "output_limit" | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const environment = safeEnvironment();
  const child = Bun.spawn(
    [
      "/usr/bin/env",
      "-i",
      ...Object.entries(environment).map(([name, value]) => `${name}=${value}`),
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-lc",
      normalizedCommand,
    ],
    {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const stop = (reason: "timeout" | "output_limit"): void => {
    if (stopReason !== undefined) {
      return;
    }
    stopReason = reason;
    stopController.abort();
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
  };

  const timeout = setTimeout(() => stop("timeout"), ADMIN_EXEC_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    captureOutput(child.stdout, stopController.signal, () => stop("output_limit")),
    captureOutput(child.stderr, stopController.signal, () => stop("output_limit")),
    child.exited,
  ]);
  clearTimeout(timeout);
  if (forceKillTimer !== undefined) {
    clearTimeout(forceKillTimer);
  }

  return {
    command: normalizedCommand,
    cwd,
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode,
    timedOut: stopReason === "timeout",
    outputTruncated: stopReason === "output_limit" || stdout.truncated || stderr.truncated,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

function truncateCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatOutput(label: string, value: string, truncated: boolean): string {
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

export function formatOperatorExecResult(result: OperatorExecResult): string {
  const command = truncateCodePoints(result.command, ADMIN_EXEC_COMMAND_DISPLAY_LIMIT);
  const commandClipped = command.length < result.command.length;
  const exit = result.timedOut ? "timeout" : String(result.exitCode);
  return [
    "<b>Operator command</b>",
    `<b>command:</b> <code>${escapeHtml(command)}${commandClipped ? "…" : ""}</code>`,
    `<b>cwd:</b> <code>${escapeHtml(result.cwd)}</code>`,
    `<b>exit:</b> <code>${exit}</code>  <b>time:</b> <code>${result.elapsedMs} ms</code>`,
    "<b>stdin:</b> <code>(empty)</code>",
    formatOutput("stdout", result.stdout, result.outputTruncated),
    formatOutput("stderr", result.stderr, result.outputTruncated),
  ].join("\n\n");
}
