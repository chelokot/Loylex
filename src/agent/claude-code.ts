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
import { toolActivity } from "./tool-activity.ts";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; is_error?: boolean };
type ResultUsage = {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  output_tokens_details: { thinking_tokens: number };
};
type RateLimitInfo = {
  status?: string;
  resetsAt?: number;
};
type StructuredApiError = {
  error?: string;
  api_error_status?: number | null;
  api_error_type?: string;
  api_error?: string;
};
type StreamMessage =
  | { type: "system"; subtype: string; session_id: string }
  | ({
      type: "assistant" | "user";
      parent_tool_use_id: string | null;
      message: { content: string | ContentBlock[] };
      api_error_params?: { rate_limit_info?: RateLimitInfo };
    } & StructuredApiError)
  | ({
      type: "result";
      subtype: string;
      is_error: boolean;
      result?: string;
      errors?: string[];
      usage?: ResultUsage;
      queued_turn_count?: number;
    } & StructuredApiError)
  | { type: "control_request"; request_id: string }
  | { type: "rate_limit_event"; rate_limit_info?: RateLimitInfo }
  | { type: "control_response" | "stream_event" };

// Tools that wait for a person at a terminal or schedule work inside the short-lived process.
const unavailableTools = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "PushNotification",
];

function tokenUsage(usage: ResultUsage): AgentTokenUsage {
  const inputTokens =
    usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  return {
    inputTokens,
    cachedInputTokens: usage.cache_read_input_tokens,
    cacheWriteInputTokens: usage.cache_creation_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.output_tokens_details.thinking_tokens,
    totalTokens: inputTokens + usage.output_tokens,
  };
}

const limitErrorCodes = new Set(["rate_limit", "billing_error"]);
const limitApiErrorTypes = new Set(["rate_limit_error", "billing_error"]);
const limitApiErrors = new Set(["usage_limit_reached", "extra_usage_out_of_credits"]);

function isStructuredLimitError(message: StructuredApiError): boolean {
  return (
    message.api_error_status === 429 ||
    (typeof message.error === "string" && limitErrorCodes.has(message.error)) ||
    (typeof message.api_error_type === "string" &&
      limitApiErrorTypes.has(message.api_error_type)) ||
    (typeof message.api_error === "string" && limitApiErrors.has(message.api_error))
  );
}

function normalizeResetTimestampMs(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? Math.round(value * 1_000) : Math.round(value);
}

export function isClaudeLimitMessage(text: string): boolean {
  return (
    /hit your(?:\s+[\w-]+)*\s+limit/i.test(text) ||
    /\brate[\s_-]?limit(?:ed|s|_error)?\b/i.test(text) ||
    /\busage[\s_-]?limit(?:[\s_-]?reached)?\b/i.test(text) ||
    /\bspend(?:ing)?\s+limit\b/i.test(text) ||
    /\bout of extra usage\b|\bextra_usage_out_of_credits\b/i.test(text) ||
    /\bquota\s+exceeded\b|\btoo\s+many\s+requests\b/i.test(text) ||
    /(?:api\s+error|http|status)[:\s]+429\b|\b429\b[^\n]{0,80}(?:rate|limit|quota|too many)/i.test(
      text,
    )
  );
}

// A private stream-json process per job: the session ID is chosen here, so every event,
// usage record, and failure is attributable before the model answers.
export async function runClaudeCode(
  config: AgentConfig,
  { instructions, prompt, resumeThreadId, signal, onEvent, onUsage, onReady }: AgentRun,
): Promise<AgentRunResult> {
  if (signal.aborted) throw new AgentCancelledError();
  const threadId = resumeThreadId ?? crypto.randomUUID();
  const effort = resumeThreadId ? config.claudeFollowUpEffort : config.claudeEffort;
  const child = Bun.spawn(
    [
      config.claudeBinary,
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      config.claudeModel,
      "--effort",
      effort,
      "--permission-mode",
      "bypassPermissions",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--disallowedTools",
      unavailableTools.join(","),
      "--append-system-prompt",
      instructions,
      ...(resumeThreadId ? ["--resume", resumeThreadId] : ["--session-id", threadId]),
    ],
    {
      cwd: config.repositoryPath,
      env: {
        ...process.env,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        LOYLEX_MEMORY_PATH: config.memoryPath,
        ...(config.claudeProxy
          ? {
              HTTPS_PROXY: config.claudeProxy,
              NO_PROXY: "localhost,127.0.0.1,loylex-gateway,host.containers.internal",
            }
          : {}),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let stderr = "";
  const stderrReader = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) stderr = (stderr + decoder.decode(chunk)).slice(-4_000);
  })();
  let completed = false;
  let answer = "";
  let failure: string | null = null;
  let rateLimitRejected = false;
  let apiLimitError = false;
  let resetsAtMs: number | null = null;
  let pendingMessage = "";
  let usage: AgentTokenUsage | undefined;
  const commands = new Set<string>();

  function recordRateLimitInfo(info: RateLimitInfo | undefined): void {
    if (!info) return;
    const normalizedReset = normalizeResetTimestampMs(info.resetsAt);
    if (normalizedReset !== null) resetsAtMs = normalizedReset;
    if (info.status === "rejected") rateLimitRejected = true;
    else if (info.status === "allowed" || info.status === "allowed_warning")
      rateLimitRejected = false;
  }

  function write(value: unknown): void {
    child.stdin.write(`${JSON.stringify(value)}\n`);
    child.stdin.flush();
  }
  function userMessage(text: string): unknown {
    return {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: threadId,
    };
  }
  function finishInput(): void {
    if (completed) return;
    completed = true;
    onReady(null);
    child.stdin.end();
  }
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): void => {
    onReady(null);
    if (!completed) {
      try {
        write({
          type: "control_request",
          request_id: "loylex-cancel",
          request: { subtype: "interrupt" },
        });
      } catch {
        // The process may already have exited; the kill timer below still applies.
      }
      finishInput();
    }
    abortTimer = setTimeout(() => child.kill("SIGTERM"), 2_000);
  };
  signal.addEventListener("abort", terminate, { once: true });

  async function emit(kind: AgentEvent["kind"], text: string, toolCallId?: string): Promise<void> {
    await onEvent({ kind, text, threadId, ...(toolCallId ? { toolCallId } : {}) });
  }
  async function flushMessage(): Promise<void> {
    if (pendingMessage.trim()) await emit("commentary", pendingMessage);
    pendingMessage = "";
  }
  async function handle(message: StreamMessage): Promise<void> {
    if (message.type === "system" && message.subtype === "init") {
      await emit("status", "Начинаю работу");
    } else if (message.type === "rate_limit_event") {
      recordRateLimitInfo(message.rate_limit_info);
    } else if (message.type === "control_request") {
      // Never invent approval or tool answers. Unsupported interactive requests fail closed.
      write({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: message.request_id,
          error: "Interactive requests are unavailable in the Telegram worker",
        },
      });
    } else if (message.type === "assistant") {
      recordRateLimitInfo(message.api_error_params?.rate_limit_info);
      if (isStructuredLimitError(message)) apiLimitError = true;
      if (Array.isArray(message.message.content) && !message.error) {
        const subagent = message.parent_tool_use_id !== null;
        for (const block of message.message.content) {
          if (block.type === "text" && !subagent) {
            await flushMessage();
            pendingMessage = block.text;
          } else if (block.type === "thinking" && block.thinking.trim() && !subagent) {
            await emit("reasoning", block.thinking.slice(0, 1_500));
          } else if (block.type === "tool_use") {
            await flushMessage();
            const command = block.input.command;
            if (block.name === "Bash" && typeof command === "string") {
              commands.add(block.id);
              await emit("command", visibleTerminalCommand(command).slice(0, 500));
            } else {
              const text = toolActivity(block);
              if (text) await emit("tool", text, block.id);
            }
          }
        }
      }
    } else if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === "tool_result" && commands.delete(block.tool_use_id))
          await emit(
            "status",
            block.is_error ? "Команда завершилась с ошибкой" : "Команда завершена",
          );
      }
    } else if (message.type === "result") {
      if (message.usage) {
        const turnUsage = tokenUsage(message.usage);
        usage = usage ? addAgentTokenUsage(usage, turnUsage) : turnUsage;
        await onUsage(usage, threadId);
      }
      pendingMessage = "";
      if (message.subtype === "success" && !message.is_error) {
        // Input that arrives after the last tool call runs as a further turn of the same job.
        answer = [answer, message.result ?? ""].filter((text) => text.trim()).join("\n\n");
        failure = null;
        apiLimitError = false;
      } else {
        if (isStructuredLimitError(message)) apiLimitError = true;
        failure = [message.result, ...(message.errors ?? [])].filter(Boolean).join("\n");
      }
      if ((message.queued_turn_count ?? 0) === 0) finishInput();
    }
  }

  try {
    write(userMessage(prompt));
    onReady({
      threadId,
      send: async (text) => {
        if (signal.aborted) throw new AgentCancelledError();
        if (completed) throw new Error("Claude Code turn has completed");
        write(userMessage(text));
      },
    });
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) await handle(JSON.parse(line) as StreamMessage);
    }
    const code = await child.exited;
    if (signal.aborted) throw new AgentCancelledError();
    if (failure !== null) {
      const detail = failure || "unknown error";
      const message = `Claude Code turn failed: ${detail}`;
      if (
        apiLimitError ||
        rateLimitRejected ||
        isClaudeLimitMessage(detail) ||
        isClaudeLimitMessage(stderr)
      ) {
        throw new AgentLimitError("claude", message, resetsAtMs);
      }
      throw new Error(message);
    }
    if (code !== 0) {
      const message = `Claude Code exited with ${code}${stderr ? `: ${stderr}` : ""}`;
      if (apiLimitError || rateLimitRejected || isClaudeLimitMessage(stderr)) {
        throw new AgentLimitError("claude", message, resetsAtMs);
      }
      throw new Error(message);
    }
    if (!answer.trim()) throw new Error("Claude Code completed without an answer");
    return { answer, threadId, ...(usage ? { usage } : {}) };
  } finally {
    onReady(null);
    signal.removeEventListener("abort", terminate);
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    if (!completed) child.stdin.end();
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await child.exited;
    clearTimeout(killTimer);
    await stderrReader.catch(() => {});
  }
}
