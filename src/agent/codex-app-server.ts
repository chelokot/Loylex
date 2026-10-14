import { visibleTerminalCommand } from "../shared/terminal-command.ts";
import type { AgentEvent } from "../shared/types.ts";
import { type AgentTokenUsage, isAgentTokenUsage } from "../shared/usage.ts";
import {
  CodexCancelledError,
  type CodexItem,
  type CodexRunResult,
  isThreadStoreConflict,
  toolActivityFromCodexItem,
  waitForThreadWriter,
} from "./codex.ts";
import { CodexSessionExtensions } from "./codex-session.ts";
import type { AgentConfig } from "./config.ts";

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
};
type Turn = { id: string; status: string; error?: { message: string } | null };
export type SteerControl = {
  threadId: string;
  send(text: string, clientId: string): Promise<void>;
};

// A private stdio server per job: no daemon, listening socket, or cross-job turn selection.
async function runCodexAppServerAttempt(
  config: AgentConfig,
  prompt: string,
  resumeThreadId: string | null,
  onEvent: (event: AgentEvent) => Promise<void>,
  signal: AbortSignal,
  onUsage: (usage: AgentTokenUsage, threadId: string) => Promise<void>,
  onReady: (control: SteerControl | null) => void,
): Promise<CodexRunResult> {
  if (signal.aborted) throw new CodexCancelledError();
  const child = Bun.spawn(
    [
      config.codexBinary,
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      `model_reasoning_effort=${config.reasoningEffort}`,
      "-c",
      `service_tier=${config.serviceTier}`,
    ],
    {
      cwd: config.repositoryPath,
      env: { ...process.env, CODEX_HOME: config.codexHome, LOYLEX_MEMORY_PATH: config.memoryPath },
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
  const pending = new Map<
    number,
    { resolve(value: Record<string, unknown>): void; reject(error: Error): void }
  >();
  let sequence = 0;
  let threadId = resumeThreadId ?? "";
  let turnId = "";
  let completed = false;
  let answer = "";
  let pendingMessage = "";
  let usage: AgentTokenUsage | undefined;
  let baseline: AgentTokenUsage | undefined;
  const tools = new Set<string>();
  const extensions = new CodexSessionExtensions(config.codexHome);

  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Failure can arrive during the handshake, before we start awaiting done.
  void done.catch(() => {});
  function write(value: unknown): void {
    child.stdin.write(`${JSON.stringify(value)}\n`);
    child.stdin.flush();
  }
  function request(method: string, params: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, 30_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        write({ id, method, params });
      } catch (error) {
        pending.get(id)?.reject(error as Error);
        pending.delete(id);
      }
    });
  }
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): void => {
    onReady(null);
    const error = new CodexCancelledError();
    if (threadId && turnId) {
      abortTimer = setTimeout(() => {
        rejectDone(error);
        child.kill("SIGTERM");
      }, 2_000);
      void request("turn/interrupt", { threadId, turnId })
        .catch(() => {})
        .finally(() => rejectDone(error));
    } else {
      rejectDone(error);
      child.kill("SIGTERM");
    }
  };
  signal.addEventListener("abort", terminate, { once: true });
  if (signal.aborted) terminate();
  async function emit(kind: AgentEvent["kind"], text: string, toolCallId?: string): Promise<void> {
    await onEvent({
      kind,
      text,
      ...(threadId ? { threadId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    });
  }
  async function flushMessage(): Promise<void> {
    if (pendingMessage.trim()) await emit("commentary", pendingMessage);
    pendingMessage = "";
  }
  async function reportTool(item: CodexItem): Promise<void> {
    if (item.id && tools.has(item.id)) return;
    const types: Record<string, string> = {
      webSearch: "web_search_call",
      fileChange: "file_change",
      imageView: "image_view",
      imageGeneration: "image_generation_call",
    };
    const text = toolActivityFromCodexItem({
      ...item,
      type: types[item.type ?? ""] ?? item.type ?? "",
    });
    if (!text) return;
    if (item.id) tools.add(item.id);
    await flushMessage();
    await emit("tool", text, item.id);
  }
  async function notification(message: RpcMessage): Promise<void> {
    const params = message.params ?? {};
    if (params.threadId && params.threadId !== threadId) return;
    if (message.method === "turn/started") turnId = (params.turn as Turn).id;
    if (message.method === "thread/tokenUsage/updated") {
      const tokenUsage = params.tokenUsage as { total?: unknown; last?: unknown };
      if (isAgentTokenUsage(tokenUsage.total) && isAgentTokenUsage(tokenUsage.last)) {
        if (!turnId || params.turnId !== turnId) {
          // Resume replays the previous turn's usage snapshot; it is a baseline, not new cost.
          baseline = { ...tokenUsage.total };
          return;
        }
        if (!baseline) {
          baseline = { ...tokenUsage.total };
          for (const key of Object.keys(baseline) as (keyof AgentTokenUsage)[]) {
            baseline[key] = Math.max(0, baseline[key] - tokenUsage.last[key]);
          }
        }
        usage = { ...tokenUsage.total };
        for (const key of Object.keys(usage) as (keyof AgentTokenUsage)[]) {
          usage[key] = Math.max(0, usage[key] - baseline[key]);
        }
        await onUsage(usage, threadId);
      }
    }
    const item = params.item as
      | (CodexItem & { phase?: string; summary?: string[]; content?: string[] })
      | undefined;
    if (item && message.method === "item/started") {
      if (item.type === "commandExecution") {
        await flushMessage();
        await emit(
          "command",
          visibleTerminalCommand(item.command ?? "terminal command").slice(0, 500),
        );
      } else await reportTool(item);
    }
    if (item && message.method === "item/completed") {
      if (item.type === "agentMessage") {
        await flushMessage();
        if (item.phase === "final_answer") answer = item.text ?? "";
        else pendingMessage = item.text ?? "";
      } else if (item.type === "commandExecution") {
        await emit("status", `Команда завершена с кодом ${item.exitCode ?? "unknown"}`);
      } else if (item.type === "reasoning") {
        const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
        if (text.trim()) await emit("reasoning", text.slice(0, 1_500));
      } else await reportTool(item);
    }
    if (message.method === "turn/completed") {
      completed = true;
      onReady(null);
      const turn = params.turn as Turn;
      if (turn.status === "completed") {
        answer ||= pendingMessage;
        pendingMessage = "";
        resolveDone();
      } else
        rejectDone(
          turn.status === "interrupted"
            ? new CodexCancelledError()
            : new Error(turn.error?.message ?? "Codex turn failed"),
        );
    }
    if (threadId && message.method?.startsWith("item/")) {
      try {
        for (const extension of await extensions.read(threadId))
          await reportTool(extension as CodexItem);
      } catch {
        // Optional journal extensions must not stop the active turn.
      }
    }
  }
  // Responses must not wait for notification callbacks: a callback can itself send steer.
  let notifications = Promise.resolve();
  const reader = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as RpcMessage;
        if (message.id !== undefined && !message.method) {
          const call = pending.get(Number(message.id));
          pending.delete(Number(message.id));
          if (message.error) call?.reject(new Error(message.error.message));
          else call?.resolve(message.result ?? {});
        } else if (message.id !== undefined) {
          // Never invent approval or tool answers. Unsupported interactive requests fail closed.
          write({
            id: message.id,
            error: {
              code: -32601,
              message: "Interactive requests are unavailable in the Telegram worker",
            },
          });
        } else {
          notifications = notifications.then(() => notification(message));
          void notifications.catch(rejectDone);
        }
      }
    }
    await notifications;
  })();
  void reader.catch(rejectDone);
  void child.exited.then((code) => {
    const error = signal.aborted
      ? new CodexCancelledError()
      : new Error(`Codex app-server exited with ${code}${stderr ? `: ${stderr}` : ""}`);
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    rejectDone(error);
  });
  try {
    if (resumeThreadId) await extensions.skipExisting(resumeThreadId);
    await request("initialize", {
      clientInfo: { name: "loylex", version: "0.1.0" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    write({ method: "initialized" });
    const options = {
      model: config.model,
      serviceTier: config.serviceTier,
      cwd: config.repositoryPath,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    };
    const thread = await request(resumeThreadId ? "thread/resume" : "thread/start", {
      ...options,
      ...(resumeThreadId ? { threadId: resumeThreadId, excludeTurns: true } : {}),
    });
    threadId = (thread.thread as { id: string }).id;
    if (!threadId) throw new Error("Codex did not provide a thread ID");
    await emit("status", "Начинаю работу");
    const input = (text: string) => [{ type: "text", text, text_elements: [] }];
    const started = await request("turn/start", {
      threadId,
      input: input(prompt),
      effort: config.reasoningEffort,
    });
    turnId = (started.turn as Turn).id;
    if (!completed)
      onReady({
        threadId,
        send: async (text, clientId) => {
          if (signal.aborted) throw new CodexCancelledError();
          if (completed) throw new Error("Codex turn has completed");
          await request("turn/steer", {
            threadId,
            expectedTurnId: turnId,
            clientUserMessageId: clientId,
            input: input(text),
          });
        },
      });
    await done;
    await notifications;
    if (signal.aborted) throw new CodexCancelledError();
    if (!answer.trim()) throw new Error("Codex completed without an answer");
    return { answer, threadId, ...(usage ? { usage } : {}) };
  } finally {
    onReady(null);
    signal.removeEventListener("abort", terminate);
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    child.stdin.end();
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await child.exited;
    clearTimeout(killTimer);
    await Promise.allSettled([reader, stderrReader]);
    for (const call of pending.values()) call.reject(new Error("Codex session closed"));
    pending.clear();
  }
}

export async function runCodexAppServer(
  ...args: Parameters<typeof runCodexAppServerAttempt>
): Promise<CodexRunResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runCodexAppServerAttempt(...args);
    } catch (error) {
      if (!args[2] || !isThreadStoreConflict(error)) throw error;
      const delays = [1000, 2000, 5000, 10000, 20000, 30000, 60000];
      await waitForThreadWriter(delays[Math.min(attempt, delays.length - 1)] ?? 60000, args[4]);
    }
  }
}
