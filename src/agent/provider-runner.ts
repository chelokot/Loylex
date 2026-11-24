import type { AgentEvent, AgentJob, AgentJobFallbackContext } from "../shared/types.ts";
import { type AgentTokenUsage, addAgentTokenUsage } from "../shared/usage.ts";
import {
  AgentCancelledError,
  AgentLimitError,
  type AgentProvider,
  type AgentRun,
  type AgentRunResult,
  type SteerControl,
} from "./agent-run.ts";
import type { StagedAttachment } from "./attachments.ts";
import { loadBuckets } from "./buckets.ts";
import type { AgentConfig } from "./config.ts";
import { agentInstructions, buildPrompt, type PromptFallbackContext } from "./prompt.ts";
import { readThreadState, type ThreadState, writeThreadState } from "./thread-state.ts";

export type ProviderRunner = (config: AgentConfig, run: AgentRun) => Promise<AgentRunResult>;

export type FallbackNotice = {
  from: AgentProvider;
  to: AgentProvider;
  reason: string;
  resumed: boolean;
  skippedPrimary: boolean;
  resetsAtMs: number | null;
  cooldownUntilMs: number | null;
};

export type ProviderCooldownOptions = {
  now?: () => number;
  defaultCooldownMs?: number;
  maxCooldownMs?: number;
  minCooldownMs?: number;
};

const defaultLimitCooldownMs = 5 * 60_000;
const maxLimitCooldownMs = 15 * 60_000;
const minLimitCooldownMs = 5_000;
const maxInterruptedActivities = 12;

export class ProviderLimitCooldown {
  private readonly until = new Map<AgentProvider, number>();
  private readonly now: () => number;
  private readonly defaultCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly minCooldownMs: number;

  constructor(options: ProviderCooldownOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultCooldownMs = options.defaultCooldownMs ?? defaultLimitCooldownMs;
    this.maxCooldownMs = options.maxCooldownMs ?? maxLimitCooldownMs;
    this.minCooldownMs = options.minCooldownMs ?? minLimitCooldownMs;
  }

  limitedUntil(provider: AgentProvider): number | null {
    const deadline = this.until.get(provider);
    if (deadline === undefined) return null;
    if (this.now() >= deadline) {
      this.until.delete(provider);
      return null;
    }
    return deadline;
  }

  isLimited(provider: AgentProvider): boolean {
    return this.limitedUntil(provider) !== null;
  }

  recordLimit(provider: AgentProvider, resetsAtMs: number | null): number {
    const current = this.now();
    const durationMs =
      resetsAtMs !== null && resetsAtMs > current
        ? Math.min(Math.max(resetsAtMs - current, this.minCooldownMs), this.maxCooldownMs)
        : this.defaultCooldownMs;
    const deadline = current + durationMs;
    const existing = this.until.get(provider);
    const effective = existing !== undefined && existing > deadline ? existing : deadline;
    this.until.set(provider, effective);
    return effective;
  }

  clear(provider: AgentProvider): void {
    this.until.delete(provider);
  }
}

export type ExecuteJobOptions = {
  config: AgentConfig;
  job: AgentJob;
  stagedAttachments: StagedAttachment[];
  signal: AbortSignal;
  cooldown: ProviderLimitCooldown;
  runners: Record<AgentProvider, ProviderRunner>;
  isCancelled(): Promise<boolean>;
  loadFallbackContext(): Promise<AgentJobFallbackContext | null>;
  onEvent(event: AgentEvent): Promise<void>;
  onUsage(usage: AgentTokenUsage, threadId: string): Promise<void>;
  onReady(control: SteerControl | null): void;
  onThreadId?(threadId: string | null): void;
  onFallback?(notice: FallbackNotice): Promise<void>;
};

export type ExecuteJobResult = {
  result: AgentRunResult;
  provider: AgentProvider;
  usage: AgentTokenUsage | null;
};

function combineUsage(
  base: AgentTokenUsage | null,
  observed: AgentTokenUsage | undefined,
): AgentTokenUsage | null {
  if (!observed) return base;
  return base ? addAgentTokenUsage(base, observed) : observed;
}

function summarizeActivity(event: AgentEvent): string | null {
  if (event.kind === "command") return `- command: ${event.text.slice(0, 200)}`;
  if (event.kind === "tool") return `- tool: ${event.text.slice(0, 200)}`;
  return null;
}

async function prepareFallbackJob(
  job: AgentJob,
  loadFallbackContext: () => Promise<AgentJobFallbackContext | null>,
): Promise<{ fallbackJob: AgentJob; priorThread: string }> {
  if (job.resumeThreadId === null) {
    return { fallbackJob: job, priorThread: "" };
  }
  const fallbackContext = await loadFallbackContext();
  if (!fallbackContext) {
    return { fallbackJob: job, priorThread: "" };
  }
  return {
    fallbackJob: {
      ...job,
      context: fallbackContext.context,
      contextMode: fallbackContext.contextMode,
      replyContext: fallbackContext.replyContext,
    },
    priorThread: fallbackContext.priorThread,
  };
}

export async function executeJobWithFallback(
  options: ExecuteJobOptions,
): Promise<ExecuteJobResult> {
  const { config, job, stagedAttachments, signal, cooldown, runners } = options;
  // A thread stays with the provider that created it unless Claude Code hits a limit.
  const initialThread: ThreadState =
    job.resumeThreadId === null
      ? { provider: config.provider, injectedBuckets: [] }
      : await readThreadState(config.statePath, job.resumeThreadId);

  let accumulatedUsage: AgentTokenUsage | null = null;

  async function runAttempt(
    provider: AgentProvider,
    attemptJob: AgentJob,
    resumeThreadId: string | null,
    injected: Set<string>,
    fallback?: PromptFallbackContext,
  ): Promise<{
    result: AgentRunResult;
    usage: AgentTokenUsage | null;
    activities: string[];
  }> {
    const attemptThread: ThreadState = { provider, injectedBuckets: [...injected] };
    let rememberedThreadId: string | null = null;
    const rememberThread = async (observedThreadId: string): Promise<void> => {
      if (observedThreadId === rememberedThreadId) return;
      rememberedThreadId = observedThreadId;
      await writeThreadState(config.statePath, observedThreadId, attemptThread);
    };
    // Public group context must not pull private memory into a shared Telegram thread.
    const buckets =
      attemptJob.chatType === "private"
        ? await loadBuckets(
            config.memoryPath,
            `${attemptJob.prompt}\n${attemptJob.context}`,
            injected,
          )
        : { text: "", keys: [] };
    const prompt = buildPrompt(attemptJob, buckets.text, stagedAttachments, fallback);
    let attemptUsage: AgentTokenUsage | undefined;
    const activities: string[] = [];
    try {
      const result = await runners[provider](config, {
        instructions: agentInstructions(provider),
        prompt,
        resumeThreadId,
        signal,
        onEvent: async (event) => {
          const summary = summarizeActivity(event);
          if (summary && activities.length < maxInterruptedActivities) {
            activities.push(summary);
          }
          if (event.threadId) {
            options.onThreadId?.(event.threadId);
            await rememberThread(event.threadId);
          }
          await options.onEvent(event);
        },
        onUsage: async (observedUsage, observedThreadId) => {
          attemptUsage = observedUsage;
          options.onThreadId?.(observedThreadId);
          const totalUsage = combineUsage(accumulatedUsage, observedUsage);
          if (totalUsage) {
            await options.onUsage(totalUsage, observedThreadId);
          }
        },
        onReady: options.onReady,
      });
      cooldown.clear(provider);
      const totalUsage = combineUsage(accumulatedUsage, result.usage ?? attemptUsage);
      options.onThreadId?.(result.threadId);
      await writeThreadState(config.statePath, result.threadId, {
        provider,
        injectedBuckets: [...injected, ...buckets.keys],
      });
      return {
        result: { ...result, ...(totalUsage ? { usage: totalUsage } : {}) },
        usage: totalUsage,
        activities,
      };
    } catch (error) {
      accumulatedUsage = combineUsage(accumulatedUsage, attemptUsage);
      if (error instanceof AgentLimitError && activities.length > 0) {
        (error as AgentLimitError & { interruptedActivities?: string[] }).interruptedActivities =
          activities;
      }
      throw error;
    }
  }

  async function runCodexFallback(
    notice: FallbackNotice,
    interruptedActivities: string[] = [],
  ): Promise<ExecuteJobResult> {
    options.onThreadId?.(job.resumeThreadId);
    await options.onFallback?.(notice);
    if (await options.isCancelled()) {
      throw new AgentCancelledError();
    }
    const { fallbackJob, priorThread } = await prepareFallbackJob(job, options.loadFallbackContext);
    const interruptedWork = interruptedActivities.join("\n");
    const fallbackPrompt: PromptFallbackContext | undefined =
      priorThread || interruptedWork
        ? {
            ...(priorThread ? { priorThread } : {}),
            ...(interruptedWork ? { interruptedWork } : {}),
          }
        : undefined;
    const completed = await runAttempt("codex", fallbackJob, null, new Set(), fallbackPrompt);
    return { result: completed.result, provider: "codex", usage: completed.usage };
  }

  const claudeCooldownUntil =
    initialThread.provider === "claude" ? cooldown.limitedUntil("claude") : null;
  if (claudeCooldownUntil !== null) {
    return await runCodexFallback({
      from: "claude",
      to: "codex",
      reason: "Claude Code limit cooldown active",
      resumed: job.resumeThreadId !== null,
      skippedPrimary: true,
      resetsAtMs: null,
      cooldownUntilMs: claudeCooldownUntil,
    });
  }

  try {
    const completed = await runAttempt(
      initialThread.provider,
      job,
      job.resumeThreadId,
      new Set(initialThread.injectedBuckets),
    );
    return { result: completed.result, provider: initialThread.provider, usage: completed.usage };
  } catch (error) {
    if (initialThread.provider !== "claude" || !(error instanceof AgentLimitError)) {
      throw error;
    }
    const cooldownUntilMs = cooldown.recordLimit("claude", error.resetsAtMs);
    const interruptedActivities =
      (error as AgentLimitError & { interruptedActivities?: string[] }).interruptedActivities ?? [];
    try {
      return await runCodexFallback(
        {
          from: "claude",
          to: "codex",
          reason: error.message,
          resumed: job.resumeThreadId !== null,
          skippedPrimary: false,
          resetsAtMs: error.resetsAtMs,
          cooldownUntilMs,
        },
        interruptedActivities,
      );
    } catch (fallbackError) {
      if (fallbackError instanceof AgentCancelledError) throw fallbackError;
      const fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`${error.message}; Codex fallback failed: ${fallbackMessage}`);
    }
  }
}
