import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unavailableAssessment } from "../shared/assessment.ts";
import type { AgentJob } from "../shared/types.ts";
import { type AgentTokenUsage, addAgentTokenUsage } from "../shared/usage.ts";
import type { AgentProvider, AgentRun, AgentRunResult, SteerControl } from "./agent-run.ts";
import { runAntigravity } from "./antigravity.ts";
import { assessConversation } from "./assessment.ts";
import { stageAttachments } from "./attachments.ts";
import { runClaudeCode } from "./claude-code.ts";
import { runCodexAppServer } from "./codex-app-server.ts";
import { type AgentConfig, loadAgentConfig } from "./config.ts";
import { GatewayClient } from "./gateway.ts";
import { newGeneratedImages, snapshotGeneratedImages } from "./generated-images.ts";
import { assertTrustedInstructions } from "./instruction-integrity.ts";
import { reportProgress } from "./progress.ts";
import { buildPrompt } from "./prompt.ts";
import { executeJobWithFallback, ProviderLimitCooldown, providerLabel } from "./provider-runner.ts";

const config = loadAgentConfig();
const runners: Record<
  AgentProvider,
  (config: AgentConfig, run: AgentRun) => Promise<AgentRunResult>
> = { codex: runCodexAppServer, claude: runClaudeCode, antigravity: runAntigravity };
const providerCooldown = new ProviderLimitCooldown();
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
    const generatedImagesRoot = join(config.codexHome, "generated_images");
    const generatedImagesBefore = await snapshotGeneratedImages(generatedImagesRoot);
    let explicitMediaUpload = false;
    const executed = await executeJobWithFallback({
      config,
      job,
      stagedAttachments: stagedAttachments.files,
      signal: cancellation.signal,
      cooldown: providerCooldown,
      runners,
      isCancelled: () => cancellationRequested(job.id, cancellation),
      loadFallbackContext: () =>
        gateway.fallbackContext(job.id).catch((error) => {
          console.error(
            JSON.stringify({
              level: "warn",
              jobId: job.id,
              event: "fallback_context_unavailable",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
          return null;
        }),
      onEvent: async (event) => {
        explicitMediaUpload ||= isMediaUploadCommand(event);
        await reportProgress(gateway, job.id, event);
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
      onThreadId: (observedThreadId) => {
        threadId = observedThreadId;
      },
      onFallback: async (notice) => {
        console.error(
          JSON.stringify({
            level: "warn",
            jobId: job.id,
            event: "provider_fallback",
            ...notice,
          }),
        );
        await reportProgress(gateway, job.id, {
          kind: "status",
          text: `Лимит ${providerLabel(notice.from)} — переключаюсь на ${providerLabel(notice.to)}`,
        });
      },
    });
    const result = executed.result;
    for (const steer of await gateway.pendingSteers(job.id).catch(() => [])) {
      await gateway
        .finishSteer(job.id, steer.id, deliveredSteers.get(steer.id) ?? false)
        .catch(() => {});
    }
    usage = executed.usage ?? usage;
    threadId = result.threadId;
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
        await reportProgress(gateway, job.id, {
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
          usage = addAgentTokenUsage(answerUsage, evaluationUsage);
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
