import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unavailableAssessment } from "../shared/assessment.ts";
import type { AgentJob } from "../shared/types.ts";
import type { AgentTokenUsage } from "../shared/usage.ts";
import type { AgentProvider, AgentRun, AgentRunResult, SteerControl } from "./agent-run.ts";
import { assessConversation } from "./assessment.ts";
import { stageAttachments } from "./attachments.ts";
import { loadBuckets } from "./buckets.ts";
import { runClaudeCode } from "./claude-code.ts";
import { runCodexAppServer } from "./codex-app-server.ts";
import { type AgentConfig, loadAgentConfig } from "./config.ts";
import { GatewayClient } from "./gateway.ts";
import { newGeneratedImages, snapshotGeneratedImages } from "./generated-images.ts";
import { assertTrustedInstructions } from "./instruction-integrity.ts";
import { agentInstructions, buildPrompt } from "./prompt.ts";
import { isTransientNetworkError } from "./retry.ts";
import { readThreadState, type ThreadState, writeThreadState } from "./thread-state.ts";

const config = loadAgentConfig();
const runners: Record<
  AgentProvider,
  (config: AgentConfig, run: AgentRun) => Promise<AgentRunResult>
> = { codex: runCodexAppServer, claude: runClaudeCode };
const gateway = new GatewayClient(config.bridgeUrl, config.bridgeToken);
let stopping = false;
const leaseHeartbeatIntervalMs = 20_000;
const workerHeartbeatIntervalMs = 5_000;
const workerReadyPath = process.env.LOYLEX_WORKER_READY_PATH ?? "/tmp/loylex-worker-ready";
const trustedInstructionsRoot = process.env.LOYLEX_TRUSTED_INSTRUCTIONS_PATH ?? "/opt/loylex/seed";

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

async function monitorCancellation(jobId: number, controller: AbortController): Promise<void> {
  let nextHeartbeatAt = Date.now() + leaseHeartbeatIntervalMs;
  while (!controller.signal.aborted) {
    try {
      if (await gateway.isCancelled(jobId)) {
        controller.abort();
        return;
      }
      if (Date.now() >= nextHeartbeatAt) {
        if (!(await gateway.heartbeat(jobId))) {
          controller.abort();
          return;
        }
        nextHeartbeatAt = Date.now() + leaseHeartbeatIntervalMs;
      }
    } catch {
      // A transient bridge failure should not stop a running job. Retry on the next poll.
    }
    if (!controller.signal.aborted) {
      await Bun.sleep(500);
    }
  }
}

async function cancellationRequested(jobId: number, controller: AbortController): Promise<boolean> {
  if (controller.signal.aborted) {
    return true;
  }
  try {
    return await gateway.isCancelled(jobId);
  } catch {
    return false;
  }
}

async function reportProgress(
  jobId: number,
  event: Parameters<GatewayClient["event"]>[1],
): Promise<void> {
  try {
    await gateway.event(jobId, event);
  } catch (error) {
    if (!isTransientNetworkError(error)) {
      throw error;
    }
    console.error(
      JSON.stringify({
        level: "warn",
        jobId,
        event: "progress_report_unavailable",
        kind: event.kind,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

function isMediaUploadCommand(event: Parameters<GatewayClient["event"]>[1]): boolean {
  return (
    event.kind === "command" && /\bloylex\s+upload(?:-album|-animation|-voice)?\b/i.test(event.text)
  );
}

async function processJob(job: AgentJob): Promise<void> {
  const cancellation = new AbortController();
  const cancellationMonitor = monitorCancellation(job.id, cancellation);
  const steerControl: { current: SteerControl | null } = { current: null };
  const deliveredSteers = new Map<number, boolean>();
  const steeringMonitor = (async () => {
    while (!cancellation.signal.aborted) {
      try {
        if (steerControl.current) {
          for (const steer of await gateway.pendingSteers(job.id)) {
            if (!steerControl.current || cancellation.signal.aborted) break;
            let accepted = deliveredSteers.get(steer.id);
            if (accepted === undefined) {
              const prompt = buildPrompt(
                {
                  ...job,
                  messageId: steer.messageId,
                  userId: steer.userId,
                  replyToMessageId: steer.replyToMessageId,
                  replyContext: null,
                  prompt: steer.prompt,
                  context: "",
                  attachments: [],
                },
                "",
              );
              try {
                await steerControl.current.send(prompt, `telegram-steer-${steer.id}`);
                accepted = true;
              } catch {
                accepted = false;
              }
              deliveredSteers.set(steer.id, accepted);
            }
            await gateway.finishSteer(job.id, steer.id, accepted);
          }
        }
      } catch {
        // Retry bridge failures without resubmitting already accepted steering input.
      }
      if (!cancellation.signal.aborted) await Bun.sleep(500);
    }
  })();
  let stagedAttachments: Awaited<ReturnType<typeof stageAttachments>> | null = null;
  let usage: AgentTokenUsage | null = null;
  let threadId = job.resumeThreadId;
  try {
    if (await cancellationRequested(job.id, cancellation)) {
      return;
    }
    stagedAttachments = await stageAttachments(gateway, job);
    // A thread stays with the provider that created it; only new threads follow the switch.
    const thread: ThreadState =
      job.resumeThreadId === null
        ? { provider: config.provider, injectedBuckets: [] }
        : await readThreadState(config.statePath, job.resumeThreadId);
    const injected = new Set(thread.injectedBuckets);
    let rememberedThreadId: string | null = null;
    const rememberThread = async (observedThreadId: string): Promise<void> => {
      if (observedThreadId === rememberedThreadId) return;
      rememberedThreadId = observedThreadId;
      await writeThreadState(config.statePath, observedThreadId, thread);
    };
    // Public group context must not pull private memory into a shared Telegram thread.
    const buckets =
      job.chatType === "private"
        ? await loadBuckets(config.memoryPath, `${job.prompt}\n${job.context}`, injected)
        : { text: "", keys: [] };
    const prompt = buildPrompt(job, buckets.text, stagedAttachments.files);
    const generatedImagesRoot = join(config.codexHome, "generated_images");
    const generatedImagesBefore = await snapshotGeneratedImages(generatedImagesRoot);
    let explicitMediaUpload = false;
    const result = await runners[thread.provider](config, {
      instructions: agentInstructions(thread.provider),
      prompt,
      resumeThreadId: job.resumeThreadId,
      signal: cancellation.signal,
      onEvent: async (event) => {
        explicitMediaUpload ||= isMediaUploadCommand(event);
        if (event.threadId) {
          threadId = event.threadId;
          await rememberThread(event.threadId);
        }
        await reportProgress(job.id, event);
      },
      onUsage: async (observedUsage, observedThreadId) => {
        usage = observedUsage;
        threadId = observedThreadId;
        await gateway.recordUsage(job.id, observedUsage, threadId).catch((error) => {
          console.error(
            JSON.stringify({
              level: "warn",
              jobId: job.id,
              event: "usage_record_failed",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        });
      },
      onReady: (control) => {
        steerControl.current = control;
      },
    });
    for (const steer of await gateway.pendingSteers(job.id).catch(() => [])) {
      await gateway
        .finishSteer(job.id, steer.id, deliveredSteers.get(steer.id) ?? false)
        .catch(() => {});
    }
    usage = result.usage ?? usage;
    threadId = result.threadId;
    await writeThreadState(config.statePath, threadId, {
      provider: thread.provider,
      injectedBuckets: [...injected, ...buckets.keys],
    });
    if (await cancellationRequested(job.id, cancellation)) {
      return;
    }
    if (!explicitMediaUpload) {
      const generatedImages = await newGeneratedImages(
        generatedImagesRoot,
        generatedImagesBefore,
        result.threadId,
      );
      const generatedImage = generatedImages.at(-1);
      if (generatedImage) {
        await reportProgress(job.id, {
          kind: "commentary",
          text: "Изображение готово — отправляю его в Telegram.",
          ...(threadId ? { threadId } : {}),
        });
        await gateway.uploadFile(job.chatId, generatedImage.path, {
          ...(job.chatType === "private" ? {} : { replyTo: job.messageId }),
          threadId: job.messageThreadId,
        });
      }
    }
    if (await cancellationRequested(job.id, cancellation)) {
      return;
    }
    const answerUsage = result.usage ?? usage;
    const assessment = job.leylobucks?.pendingAssessment
      ? await assessConversation(config, job, cancellation.signal, (evaluationUsage) => {
          if (!answerUsage) {
            usage = evaluationUsage;
            return;
          }
          usage = {
            inputTokens: answerUsage.inputTokens + evaluationUsage.inputTokens,
            cachedInputTokens: answerUsage.cachedInputTokens + evaluationUsage.cachedInputTokens,
            cacheWriteInputTokens:
              answerUsage.cacheWriteInputTokens + evaluationUsage.cacheWriteInputTokens,
            outputTokens: answerUsage.outputTokens + evaluationUsage.outputTokens,
            reasoningOutputTokens:
              answerUsage.reasoningOutputTokens + evaluationUsage.reasoningOutputTokens,
            totalTokens: answerUsage.totalTokens + evaluationUsage.totalTokens,
          };
        }).catch(() => unavailableAssessment)
      : undefined;
    if (await cancellationRequested(job.id, cancellation)) return;
    await gateway.complete(job.id, {
      ...result,
      ...(usage ? { usage } : {}),
      ...(assessment ? { assessment } : {}),
    });
  } catch (error) {
    if (await cancellationRequested(job.id, cancellation)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ level: "error", jobId: job.id, message }));
    await gateway.fail(job.id, message, usage, threadId);
  } finally {
    await stagedAttachments?.cleanup();
    cancellation.abort();
    await Promise.all([cancellationMonitor, steeringMonitor]);
  }
}

const activeJobs = new Set<Promise<void>>();

function startJob(job: AgentJob): void {
  let task: Promise<void>;
  task = processJob(job).finally(() => activeJobs.delete(task));
  activeJobs.add(task);
}

await assertTrustedInstructions(config.repositoryPath, trustedInstructionsRoot);
await unlink(workerReadyPath).catch(() => {});
const registration = await gateway.registerWorker();
await writeFile(workerReadyPath, `${process.pid}\n`);
let drainRequested = registration.state === "draining";
const workerHeartbeatTimer = setInterval(() => {
  void gateway
    .heartbeatWorker()
    .then((alive) => {
      if (!alive) {
        stopping = true;
      }
    })
    .catch(() => {
      // A transient bridge failure should not stop the worker. The next heartbeat retries it.
    });
}, workerHeartbeatIntervalMs);

while (!stopping && !drainRequested) {
  if (activeJobs.size >= config.maxConcurrentJobs) {
    await Promise.race(activeJobs);
    continue;
  }
  try {
    const poll = await gateway.next();
    if (poll.job) {
      startJob(poll.job);
      continue;
    }
    if (poll.draining) {
      drainRequested = true;
      continue;
    }
  } catch (error) {
    console.error(error);
  }
  await Promise.race([Bun.sleep(config.pollIntervalMs), ...activeJobs]);
}

await Promise.allSettled(activeJobs);
clearInterval(workerHeartbeatTimer);
await gateway.stopWorker().catch(() => {
  // The bridge may already be unavailable while the process is shutting down.
});
await unlink(workerReadyPath).catch(() => {});
