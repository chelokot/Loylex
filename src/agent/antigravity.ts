import { visibleTerminalCommand } from "../shared/terminal-command.ts";
import type { AgentEvent } from "../shared/types.ts";
import { type AgentTokenUsage, addAgentTokenUsage } from "../shared/usage.ts";
import {
  AgentCancelledError,
  AgentLimitError,
  type AgentRun,
  type AgentRunResult,
} from "./agent-run.ts";
import type { AgentConfig } from "./config.ts";

type AntigravityUsage = {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
};

type AntigravityToolInfo = {
  name?: string;
  parameters?: Record<string, unknown>;
  output?: string;
  error?: { type?: string; message?: string };
};

type AntigravityStepUpdate = {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  tool_name?: string;
  text_delta?: string;
  usage?: AntigravityUsage;
  tool_info?: AntigravityToolInfo;
};

type AntigravityResult = {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  usage?: AntigravityUsage;
};

type AntigravityEvent =
  | { event: "init"; conversation_id?: string }
  | { event: "step_update"; step_update?: AntigravityStepUpdate }
  | { event: "result"; result?: AntigravityResult };

const limitMessagePatterns = [
  /rate[-\s]?limit/i,
  /too many requests/i,
  /\b429\b/,
  /resource_exhausted/i,
  /quota\s+(?:exceeded|reached|exhausted|limit)/i,
  /usage limit/i,
  /out of (?:credits|quota)/i,
  /model quota/i,
];

export function isAntigravityLimitMessage(message: string): boolean {
  return limitMessagePatterns.some((pattern) => pattern.test(message));
}

function nonNeg(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function tokenUsage(usage: AntigravityUsage | undefined): AgentTokenUsage | null {
  if (!usage) return null;
  const cachedInputTokens = nonNeg(usage.cache_read_tokens);
  const inputTokens = Math.max(nonNeg(usage.input_tokens), cachedInputTokens);
  const outputTokens = nonNeg(usage.output_tokens);
  const reasoningOutputTokens = nonNeg(usage.thinking_tokens);
  const totalTokens = Math.max(nonNeg(usage.total_tokens), inputTokens + outputTokens);
  if (totalTokens === 0 && inputTokens === 0 && outputTokens === 0) return null;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function commandLineFromParameters(params: Record<string, unknown> | undefined): string {
  const value = params?.CommandLine ?? params?.command;
  return typeof value === "string" && value.trim() ? value : "terminal command";
}

function describeAntigravityTool(
  toolName: string,
  params: Record<string, unknown> | undefined,
): string {
  const stringField = (keys: string[]): string => {
    for (const key of keys) {
      const value = params?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };
  const target = stringField([
    "AbsolutePath",
    "TargetFile",
    "DirectoryPath",
    "SearchPath",
    "Url",
    "query",
    "Query",
    "Pattern",
    "ImageName",
  ]);
  if (toolName === "search_web" && target) return `Search web: ${target}`.slice(0, 500);
  if (toolName === "read_url_content" && target) return `Fetch ${target}`.slice(0, 500);
  if (toolName === "view_file" && target) return `Read ${target}`.slice(0, 500);
  if (
    (toolName === "write_to_file" ||
      toolName === "replace_file_content" ||
      toolName === "multi_replace_file_content") &&
    target
  ) {
    return `Edit ${target}`.slice(0, 500);
  }
  if (toolName === "grep_search" && target) return `Search ${target}`.slice(0, 500);
  if (toolName === "find_by_name" && target) return `Find files in ${target}`.slice(0, 500);
  if (toolName === "list_dir" && target) return `List ${target}`.slice(0, 500);
  return target ? `${toolName}: ${target}`.slice(0, 500) : `Used ${toolName}`.slice(0, 500);
}

function antigravityEnv(config: AgentConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.LOYLEX_MEMORY_PATH = config.memoryPath;
  if (config.antigravityProxy) {
    const noProxy = "localhost,127.0.0.1,gateway,loylex-gateway,host.containers.internal";
    env.HTTP_PROXY = config.antigravityProxy;
    env.HTTPS_PROXY = config.antigravityProxy;
    env.http_proxy = config.antigravityProxy;
    env.https_proxy = config.antigravityProxy;
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }
  return env;
}

export async function runAntigravity(
  config: AgentConfig,
  { instructions, prompt, resumeThreadId, signal, onEvent, onUsage, onReady }: AgentRun,
): Promise<AgentRunResult> {
  if (signal.aborted) throw new AgentCancelledError();
  const args = [
    config.antigravityBinary,
    "--model",
    config.antigravityModel,
    ...(config.antigravityEffort ? ["--effort", config.antigravityEffort] : []),
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--settings",
    JSON.stringify({ allowNonWorkspaceAccess: true }),
    "--add-dir",
    config.memoryPath,
    ...(resumeThreadId ? ["--conversation", resumeThreadId] : []),
  ];
  const child = Bun.spawn(args, {
    cwd: config.repositoryPath,
    env: antigravityEnv(config),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stderr = "";
  const stderrReader = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) stderr = (stderr + decoder.decode(chunk)).slice(-4_000);
  })();

  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    child.kill("SIGTERM");
    abortTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  };
  signal.addEventListener("abort", terminate, { once: true });

  let threadId = resumeThreadId ?? "";
  let completed = false;
  let stdinClosed = false;
  let pendingTurns = 0;
  let answer = "";
  let stepUsageTotal: AgentTokenUsage | null = null;
  let resultUsageFallback: AgentTokenUsage | undefined;
  let terminalError: Error | null = null;
  const reportedToolSteps = new Set<number>();
  const countedUsageSteps = new Set<number>();

  const emit = async (kind: AgentEvent["kind"], text: string, toolCallId?: string) => {
    await onEvent({
      kind,
      text,
      ...(threadId ? { threadId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    });
  };

  const closeInput = () => {
    if (stdinClosed) return;
    stdinClosed = true;
    child.stdin.end();
  };

  const writeUser = (content: string) => {
    if (stdinClosed) throw new Error("Antigravity session input is closed");
    pendingTurns += 1;
    child.stdin.write(`${JSON.stringify({ event: "user", message: { content } })}\n`);
    void child.stdin.flush();
  };

  const initialContent = resumeThreadId ? prompt : `${instructions}\n\n${prompt}`;

  try {
    writeUser(initialContent);
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as AntigravityEvent;
        if (message.event === "init") {
          if (message.conversation_id) threadId = message.conversation_id;
          await emit("status", "Начинаю работу");
          if (threadId) {
            onReady({
              threadId,
              send: async (text) => {
                if (signal.aborted) throw new AgentCancelledError();
                if (completed || stdinClosed) throw new Error("Antigravity turn has completed");
                writeUser(text);
              },
            });
          }
          continue;
        }
        if (message.event === "step_update" && message.step_update) {
          const step = message.step_update;
          if (!threadId && step.conversation_id) threadId = step.conversation_id;
          const stepIndex = typeof step.step_index === "number" ? step.step_index : -1;
          if (step.step_type === "tool") {
            const toolName = step.tool_name ?? step.tool_info?.name ?? "tool";
            if (stepIndex < 0 || !reportedToolSteps.has(stepIndex)) {
              if (stepIndex >= 0) reportedToolSteps.add(stepIndex);
              if (toolName === "run_command") {
                await emit(
                  "command",
                  visibleTerminalCommand(
                    commandLineFromParameters(step.tool_info?.parameters),
                  ).slice(0, 500),
                );
              } else {
                await emit(
                  "tool",
                  describeAntigravityTool(toolName, step.tool_info?.parameters),
                  stepIndex >= 0 ? `agy-step-${stepIndex}` : undefined,
                );
              }
            }
          }
          if (
            step.state === "DONE" &&
            step.usage &&
            (stepIndex < 0 || !countedUsageSteps.has(stepIndex))
          ) {
            const parsed = tokenUsage(step.usage);
            if (parsed) {
              if (stepIndex >= 0) countedUsageSteps.add(stepIndex);
              stepUsageTotal = stepUsageTotal ? addAgentTokenUsage(stepUsageTotal, parsed) : parsed;
              if (threadId) await onUsage(stepUsageTotal, threadId);
            }
          }
          continue;
        }
        if (message.event === "result" && message.result) {
          const result = message.result;
          if (!threadId && result.conversation_id) threadId = result.conversation_id;
          pendingTurns = Math.max(0, pendingTurns - 1);
          const parsedResultUsage = tokenUsage(result.usage);
          if (parsedResultUsage) resultUsageFallback = parsedResultUsage;
          if (result.status === "CANCELED" || result.status === "INTERRUPTED") {
            terminalError = new AgentCancelledError();
            completed = true;
            onReady(null);
            closeInput();
            continue;
          }
          if (result.status !== "SUCCESS") {
            const detail =
              result.error?.trim() || `Antigravity turn failed (${result.status ?? "unknown"})`;
            terminalError = isAntigravityLimitMessage(detail)
              ? new AgentLimitError("antigravity", detail)
              : new Error(detail);
            completed = true;
            onReady(null);
            closeInput();
            continue;
          }
          if (typeof result.response === "string") {
            answer = result.response;
          }
          if (!stepUsageTotal && resultUsageFallback && threadId) {
            await onUsage(resultUsageFallback, threadId);
          }
          if (pendingTurns === 0) {
            completed = true;
            onReady(null);
            closeInput();
          }
        }
      }
    }
    const exitCode = await child.exited;
    await stderrReader;
    if (signal.aborted) throw new AgentCancelledError();
    if (terminalError) throw terminalError;
    if (exitCode !== 0) {
      const detail = stderr.trim();
      const message = `Antigravity exited with ${exitCode}${detail ? `: ${detail}` : ""}`;
      if (isAntigravityLimitMessage(message)) {
        throw new AgentLimitError("antigravity", message);
      }
      throw new Error(message);
    }
    if (!threadId) throw new Error("Antigravity did not provide a conversation ID");
    if (!answer.trim()) throw new Error("Antigravity completed without an answer");
    const finalUsage = stepUsageTotal ?? resultUsageFallback;
    return { answer, threadId, ...(finalUsage ? { usage: finalUsage } : {}) };
  } finally {
    onReady(null);
    signal.removeEventListener("abort", terminate);
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    closeInput();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await child.exited;
      clearTimeout(killTimer);
    }
    await stderrReader;
  }
}
