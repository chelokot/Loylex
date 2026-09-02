import type { AgentEvent } from "../shared/types.ts";
import type { AgentTokenUsage } from "../shared/usage.ts";
import type { AgentConfig } from "./config.ts";

type CodexItem = {
  type?: string;
  text?: string;
  command?: string;
  exit_code?: number;
};

type CodexJsonEvent = {
  type?: string;
  thread_id?: string;
  message?: string;
  item?: CodexItem;
  usage?: unknown;
  token_usage?: unknown;
};

export type CodexRunResult = {
  answer: string;
  threadId: string;
  usage?: AgentTokenUsage;
};

type UsageObserver = (usage: AgentTokenUsage, threadId: string | null) => Promise<void> | void;

export class CodexCancelledError extends Error {
  constructor() {
    super("Codex run cancelled");
    this.name = "CodexCancelledError";
  }
}

const threadConflictRetryDelaysMs = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000] as const;

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name} ${error.message}` : String(error);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usageFromRecord(value: unknown): AgentTokenUsage | null {
  const usage = record(value);
  if (!usage) {
    return null;
  }
  const inputTokens = nonNegativeInteger(usage.input_tokens);
  const cachedInputTokens = nonNegativeInteger(usage.cached_input_tokens);
  const cacheWriteInputTokens = nonNegativeInteger(usage.cache_write_input_tokens);
  const outputTokens = nonNegativeInteger(usage.output_tokens);
  const reasoningOutputTokens = nonNegativeInteger(usage.reasoning_output_tokens);
  const totalTokens = nonNegativeInteger(usage.total_tokens);
  if (inputTokens === null && outputTokens === null) {
    return null;
  }
  const normalizedInputTokens = inputTokens ?? 0;
  const normalizedOutputTokens = outputTokens ?? 0;
  const computedTotal = normalizedInputTokens + normalizedOutputTokens;
  return {
    inputTokens: normalizedInputTokens,
    cachedInputTokens: cachedInputTokens ?? 0,
    cacheWriteInputTokens: cacheWriteInputTokens ?? 0,
    outputTokens: normalizedOutputTokens,
    reasoningOutputTokens: reasoningOutputTokens ?? 0,
    totalTokens: totalTokens ?? (Number.isSafeInteger(computedTotal) ? computedTotal : 0),
  };
}

export function parseCodexUsage(event: unknown): AgentTokenUsage | null {
  const value = record(event);
  if (!value) {
    return null;
  }
  for (const candidate of [value.usage, value.token_usage]) {
    const usage = usageFromRecord(candidate);
    if (usage) {
      return usage;
    }
  }
  return null;
}

function sameUsage(left: AgentTokenUsage | null, right: AgentTokenUsage): boolean {
  return (
    left !== null &&
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.cacheWriteInputTokens === right.cacheWriteInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningOutputTokens === right.reasoningOutputTokens &&
    left.totalTokens === right.totalTokens
  );
}

export function isThreadStoreConflict(error: unknown): boolean {
  return /thread-store conflict\b[\s\S]*\bactive writer\b/i.test(errorText(error));
}

async function waitForThreadWriter(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    throw new CodexCancelledError();
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    function abort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new CodexCancelledError());
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function runCodexAttempt(
  config: AgentConfig,
  prompt: string,
  resumeThreadId: string | null,
  onEvent: (event: AgentEvent) => Promise<void>,
  signal?: AbortSignal,
  onUsage?: UsageObserver,
): Promise<CodexRunResult> {
  if (signal?.aborted) {
    throw new CodexCancelledError();
  }
  const common = [
    "--json",
    "--model",
    config.model,
    "-c",
    `model_reasoning_effort=${config.reasoningEffort}`,
    "-c",
    "check_for_update_on_startup=false",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  const arguments_ = resumeThreadId
    ? ["exec", "resume", ...common, resumeThreadId, "-"]
    : [
        "exec",
        ...common,
        "--cd",
        config.repositoryPath,
        "--add-dir",
        config.memoryPath,
        "--add-dir",
        "/workspace",
        "-",
      ];
  const child = Bun.spawn([config.codexBinary, ...arguments_], {
    cwd: config.repositoryPath,
    env: {
      ...process.env,
      CODEX_HOME: config.codexHome,
      LOYLEX_MEMORY_PATH: config.memoryPath,
    },
    stdin: new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
  });

  let terminated = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): void => {
    if (terminated) {
      return;
    }
    terminated = true;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  };
  const abortHandler = (): void => terminate();
  if (signal) {
    signal.addEventListener("abort", abortHandler, { once: true });
    if (signal.aborted) {
      terminate();
    }
  }

  try {
    let threadId = resumeThreadId;
    let finalAnswer = "";
    let pendingAgentMessage = "";
    let lastUsage: AgentTokenUsage | null = null;
    let buffered = "";
    const decoder = new TextDecoder();

    async function flushCommentary(): Promise<void> {
      if (!pendingAgentMessage.trim()) {
        return;
      }
      await onEvent({
        kind: "commentary",
        text: pendingAgentMessage,
        ...(threadId ? { threadId } : {}),
      });
      pendingAgentMessage = "";
    }

    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (signal?.aborted || !line.trim()) {
          continue;
        }
        const event = JSON.parse(line) as CodexJsonEvent;
        if (event.thread_id) {
          threadId = event.thread_id;
        }
        const usage = parseCodexUsage(event);
        if (usage && !sameUsage(lastUsage, usage)) {
          lastUsage = usage;
          await onUsage?.(usage, threadId);
        }
        if (event.type === "thread.started" && event.thread_id) {
          threadId = event.thread_id;
        } else if (event.type === "item.completed" && event.item?.type === "agent_message") {
          await flushCommentary();
          pendingAgentMessage = event.item.text ?? pendingAgentMessage;
        } else if (event.type === "turn.completed") {
          finalAnswer = pendingAgentMessage || finalAnswer;
          pendingAgentMessage = "";
        } else if (event.type === "item.started" && event.item?.type === "command_execution") {
          await flushCommentary();
          await onEvent({
            kind: "command",
            text: (event.item.command ?? "terminal command").slice(0, 500),
            ...(threadId ? { threadId } : {}),
          });
        } else if (event.type === "item.completed" && event.item?.type === "command_execution") {
          await onEvent({
            kind: "status",
            text: `Команда завершена с кодом ${event.item.exit_code ?? "unknown"}`,
            ...(threadId ? { threadId } : {}),
          });
        } else if (event.type === "item.completed" && event.item?.type === "reasoning") {
          const text = event.item.text?.trim();
          if (text) {
            await onEvent({
              kind: "reasoning",
              text: text.slice(0, 1_500),
              ...(threadId ? { threadId } : {}),
            });
          }
        } else if (event.type === "error") {
          await onEvent({
            kind: "status",
            text: event.message ?? "Codex reported an error",
            ...(threadId ? { threadId } : {}),
          });
        }
      }
    }

    const status = await child.exited;
    if (signal?.aborted) {
      throw new CodexCancelledError();
    }
    if (!finalAnswer && pendingAgentMessage) {
      finalAnswer = pendingAgentMessage;
    }
    if (status !== 0) {
      const stderr = await new Response(child.stderr).text();
      throw new Error(`Codex exited with ${status}: ${stderr.slice(-4_000)}`);
    }
    if (!threadId) {
      throw new Error("Codex did not provide a thread ID");
    }
    if (!finalAnswer.trim()) {
      throw new Error("Codex completed without an answer");
    }
    return {
      answer: finalAnswer,
      threadId,
      ...(lastUsage === null ? {} : { usage: lastUsage }),
    };
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    if (forceKillTimer !== undefined) {
      clearTimeout(forceKillTimer);
    }
  }
}

export async function runCodex(
  config: AgentConfig,
  prompt: string,
  resumeThreadId: string | null,
  onEvent: (event: AgentEvent) => Promise<void>,
  signal?: AbortSignal,
  onUsage?: UsageObserver,
): Promise<CodexRunResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runCodexAttempt(config, prompt, resumeThreadId, onEvent, signal, onUsage);
    } catch (error) {
      if (!resumeThreadId || !isThreadStoreConflict(error)) {
        throw error;
      }
      const delayMs =
        threadConflictRetryDelaysMs[Math.min(attempt, threadConflictRetryDelaysMs.length - 1)] ??
        60_000;
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "codex_thread_writer_busy",
          attempt: attempt + 1,
          retryInMs: delayMs,
        }),
      );
      await waitForThreadWriter(delayMs, signal);
    }
  }
}
