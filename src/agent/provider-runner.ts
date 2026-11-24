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
  cooldownUntilMs: number;
};

const providerLabels: Record<AgentProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};

const fallbackChain: Record<AgentProvider, readonly AgentProvider[]> = {
  claude: ["codex", "antigravity"],
  codex: ["antigravity"],
  antigravity: [],
};

export function providerLabel(provider: AgentProvider): string {
  return providerLabels[provider];
}

const defaultCooldownMs = 5 * 60_000;
const minCooldownMs = 5_000;
const maxCooldownMs = 15 * 60_000;
const maxInterruptedActivities = 15;

export type CooldownOptions = {
  now?: () => number;
  defaultCooldownMs?: number;
  minCooldownMs?: number;
  maxCooldownMs?: number;
};

// In-memory worker cooldown: after a provider hits a rate limit, subsequent jobs route straight to
// the next provider until the reset timestamp (bounded) elapses, then probe primary again.
export class ProviderLimitCooldown {
  private readonly until = new Map<AgentProvider, number>();
  private readonly now: () => number;
  private readonly defaultMs: number;
  private readonly minMs: number;
  private readonly maxMs: number;

  constructor(options: CooldownOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.defaultMs = options.defaultCooldownMs ?? defaultCooldownMs;
    this.minMs = options.minCooldownMs ?? minCooldownMs;
    this.maxMs = options.maxCooldownMs ?? maxCooldownMs;
  }

  limitedUntil(provider: AgentProvider): number | null {
    const expiresAt = this.until.get(provider);
    if (expiresAt === undefined) return null;
    if (this.now() >= expiresAt) {
      this.until.delete(provider);
      return null;
    }
    return expiresAt;
  }

  isLimited(provider: AgentProvider): boolean {
    return this.limitedUntil(provider) !== null;
  }

  recordLimit(provider: AgentProvider, resetsAtMs: number | null): number {
    const now = this.now();
    const duration =
      resetsAtMs !== null && Number.isFinite(resetsAtMs) && resetsAtMs > now
        ? Math.min(this.maxMs, Math.max(this.minMs, resetsAtMs - now))
        : this.defaultMs;
    const expiresAt = now + duration;
    const existing = this.until.get(provider) ?? 0;
    const updated = Math.max(existing, expiresAt);
    this.until.set(provider, updated);
    return updated;
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

type ProviderFailure = {
  provider: AgentProvider;
  message: string;
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

function formatFailures(failures: ProviderFailure[]): string {
  return failures
    .map((failure, index) =>
      index === 0
        ? failure.message
        : `${providerLabel(failure.provider)} fallback failed: ${failure.message}`,
    )
    .join("; ");
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
  // A thread stays with the provider that created it unless that provider hits a limit.
  const initialThread: ThreadState =
    job.resumeThreadId === null
      ? { provider: config.provider, injectedBuckets: [] }
      : await readThreadState(config.statePath, job.resumeThreadId);

  const startProvider = initialThread.provider;
  const candidates: AgentProvider[] = [startProvider, ...fallbackChain[startProvider]];
  let accumulatedUsage: AgentTokenUsage | null = null;
  let fallbackPrepared: { fallbackJob: AgentJob; priorThread: string } | null = null;
  const interruptedActivities: string[] = [];
  const failures: ProviderFailure[] = [];
  let pendingFallback: Omit<FallbackNotice, "to"> | null = null;

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

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (!candidate) break;
    const hasNext = index < candidates.length - 1;
    const cooldownUntil = cooldown.limitedUntil(candidate);
    if (hasNext && cooldownUntil !== null) {
      if (!pendingFallback) {
        pendingFallback = {
          from: candidate,
          reason: `${providerLabel(candidate)} limit cooldown active`,
          resumed: job.resumeThreadId !== null,
          skippedPrimary: candidate === startProvider,
          resetsAtMs: null,
          cooldownUntilMs: cooldownUntil,
        };
      }
      continue;
    }

    if (pendingFallback) {
      options.onThreadId?.(job.resumeThreadId);
      await options.onFallback?.({ ...pendingFallback, to: candidate });
      pendingFallback = null;
      if (await options.isCancelled()) {
        throw new AgentCancelledError();
      }
    }

    try {
      if (candidate === startProvider) {
        const completed = await runAttempt(
          startProvider,
          job,
          job.resumeThreadId,
          new Set(initialThread.injectedBuckets),
        );
        return { result: completed.result, provider: startProvider, usage: completed.usage };
      }
      fallbackPrepared ??= await prepareFallbackJob(job, options.loadFallbackContext);
      const interruptedWork = interruptedActivities.join("\n");
      const fallbackPrompt: PromptFallbackContext | undefined =
        fallbackPrepared.priorThread || interruptedWork
          ? {
              ...(fallbackPrepared.priorThread
                ? { priorThread: fallbackPrepared.priorThread }
                : {}),
              ...(interruptedWork ? { interruptedWork } : {}),
            }
          : undefined;
      const completed = await runAttempt(
        candidate,
        fallbackPrepared.fallbackJob,
        null,
        new Set(),
        fallbackPrompt,
      );
      return { result: completed.result, provider: candidate, usage: completed.usage };
    } catch (error) {
      if (error instanceof AgentCancelledError) throw error;
      if (error instanceof AgentLimitError && hasNext) {
        const cooldownUntilMs = cooldown.recordLimit(candidate, error.resetsAtMs);
        const added =
          (error as AgentLimitError & { interruptedActivities?: string[] }).interruptedActivities ??
          [];
        for (const item of added) {
          if (interruptedActivities.length < maxInterruptedActivities) {
            interruptedActivities.push(item);
          }
        }
        failures.push({ provider: candidate, message: error.message });
        pendingFallback = {
          from: candidate,
          reason: error.message,
          resumed: job.resumeThreadId !== null,
          skippedPrimary: false,
          resetsAtMs: error.resetsAtMs,
          cooldownUntilMs,
        };
        continue;
      }
      if (failures.length === 0) throw error;
      options.onThreadId?.(job.resumeThreadId);
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ provider: candidate, message });
      throw new Error(formatFailures(failures));
    }
  }

  throw new Error(formatFailures(failures) || "No agent provider available");
}
