import type { Server } from "bun";
import { isContextualAssessment, unavailableAssessment } from "../shared/assessment.ts";
import type { AgentCompletion, AgentEvent, TelegramMessage } from "../shared/types.ts";
import { isAgentTokenUsage } from "../shared/usage.ts";
import { type ApprovalClient, ApprovalDeniedError } from "./approvals.ts";
import { archiveRoute } from "./archive-routes.ts";
import type { GatewayConfig } from "./config.ts";
import type { LoylexDatabase } from "./database.ts";
import { body, json } from "./http-json.ts";
import { responseOptions } from "./message-options.ts";
import {
  completedDocuments,
  failedDocument,
  leylobucksFooter,
  workDocument,
} from "./presentation.ts";
import type { TelegramClient } from "./telegram.ts";
import { telegramRoute } from "./telegram-routes.ts";

function bearer(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

function workerId(request: Request): string | undefined {
  const value = request.headers.get("x-loylex-worker-id")?.trim();
  return value || undefined;
}

function eventStatusLine(event: AgentEvent): string {
  const text =
    event.kind === "command" || event.kind === "tool"
      ? event.text.replaceAll(/\s+/g, " ").trim()
      : event.text.trim();
  if (event.kind !== "tool" || !event.toolCallId) {
    return `${event.kind}: ${text}`;
  }
  const toolCallId = Array.from(event.toolCallId)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint !== 0x7f && character !== "[" && character !== "]";
    })
    .join("")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return toolCallId ? `${event.kind}: ${text} [tool-call:${toolCallId}]` : `${event.kind}: ${text}`;
}

export class GatewayServer {
  readonly #lastStreamEdit = new Map<number, number>();
  readonly #lastStreamDocument = new Map<number, string>();
  #server: Server<undefined> | null = null;

  constructor(
    private readonly config: GatewayConfig,
    private readonly database: LoylexDatabase,
    private readonly telegram: TelegramClient,
    private readonly isLeylobucksEnabled: (userId: number | null) => boolean = () => true,
    private readonly approvals: ApprovalClient | null = null,
  ) {}

  start(): void {
    this.database.recoverExpiredJobs();
    this.#server = Bun.serve({
      hostname: this.config.listenHost,
      port: this.config.listenPort,
      fetch: (request) => this.route(request),
    });
  }

  stop(): void {
    this.#server?.stop(true);
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return json({ ok: true, ...this.database.stats() });
    }
    if (bearer(request) !== this.config.bridgeToken) {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      if (request.method === "POST" && url.pathname === "/v1/approvals") {
        const payload = await body<{ jobId?: unknown; operation?: unknown }>(request);
        if (typeof payload.jobId !== "number" || !Number.isSafeInteger(payload.jobId)) {
          return json({ error: "jobId is required" }, 400);
        }
        if (this.approvals === null) return json({ error: "Approval broker is unavailable" }, 503);
        return json(
          await this.approvals.submit(this.database.jobAddress(payload.jobId), payload.operation),
          202,
        );
      }
      const approvalMatch = url.pathname.match(/^\/v1\/approvals\/([a-f0-9]{32})$/);
      if (request.method === "GET" && approvalMatch?.[1]) {
        if (this.approvals === null) return json({ error: "Approval broker is unavailable" }, 503);
        return json(await this.approvals.status(approvalMatch[1]));
      }
      if (request.method === "POST" && url.pathname === "/v1/leylobucks/mode") {
        const payload = await body<{ userId?: unknown; enabled?: unknown }>(request);
        if (
          typeof payload.userId !== "number" ||
          !Number.isSafeInteger(payload.userId) ||
          payload.userId <= 0 ||
          typeof payload.enabled !== "boolean"
        ) {
          return json({ error: "positive integer userId and boolean enabled are required" }, 400);
        }
        this.database.setLeylobucksEnabled(payload.userId, payload.enabled);
        return json({
          userId: payload.userId,
          enabled: this.database.isLeylobucksEnabled(payload.userId),
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/workers/register") {
        const currentWorkerId = workerId(request);
        if (!currentWorkerId) {
          return json({ error: "x-loylex-worker-id is required" }, 400);
        }
        return json(this.database.registerWorker(currentWorkerId));
      }

      if (request.method === "POST" && url.pathname === "/v1/workers/heartbeat") {
        const currentWorkerId = workerId(request);
        return json({
          alive: currentWorkerId !== undefined && this.database.heartbeatWorker(currentWorkerId),
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/workers/stop") {
        const currentWorkerId = workerId(request);
        return json({
          stopped: currentWorkerId !== undefined && this.database.stopWorker(currentWorkerId),
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/jobs/next") {
        const currentWorkerId = workerId(request);
        const response = json(
          this.database.claimNext(
            this.config.contextMessages,
            currentWorkerId ?? null,
            this.isLeylobucksEnabled,
          ),
        );
        if (currentWorkerId !== undefined && this.database.shouldDrainWorker(currentWorkerId)) {
          response.headers.set("x-loylex-drain", "true");
        }
        return response;
      }

      const steersMatch = url.pathname.match(/^\/v1\/jobs\/(\d+)\/steers$/);
      if (request.method === "GET" && steersMatch?.[1]) {
        const currentWorkerId = workerId(request);
        if (!currentWorkerId) return json({ error: "worker id required" }, 400);
        return json(this.database.pendingSteers(Number(steersMatch[1]), currentWorkerId));
      }
      const steerResultMatch = url.pathname.match(/^\/v1\/jobs\/(\d+)\/steers\/(\d+)$/);
      if (request.method === "POST" && steerResultMatch?.[1] && steerResultMatch[2]) {
        const currentWorkerId = workerId(request);
        const payload = await body<{ accepted: unknown }>(request);
        if (!currentWorkerId || typeof payload.accepted !== "boolean")
          return json({ error: "worker id and accepted required" }, 400);
        const jobId = Number(steerResultMatch[1]);
        const messageId = this.database.finishSteer(
          jobId,
          Number(steerResultMatch[2]),
          currentWorkerId,
          payload.accepted,
        );
        if (messageId !== null) {
          const address = this.database.jobAddress(jobId);
          await this.telegram.sendRich(
            address.chatId,
            payload.accepted
              ? "Уточнение передано в работающую задачу."
              : "Уточнение не удалось передать: задача уже завершилась или steer отклонён.",
            { replyTo: messageId, threadId: address.threadId },
          );
        }
        return json({ recorded: messageId !== null });
      }

      const cancellationMatch = url.pathname.match(/^\/v1\/jobs\/(\d+)\/cancelled$/);
      if (request.method === "GET" && cancellationMatch?.[1]) {
        return json({
          cancelled: this.database.isJobCancelled(Number.parseInt(cancellationMatch[1], 10)),
        });
      }

      const heartbeatMatch = url.pathname.match(/^\/v1\/jobs\/(\d+)\/heartbeat$/);
      if (request.method === "POST" && heartbeatMatch?.[1]) {
        const currentWorkerId = workerId(request);
        return json({
          owned:
            currentWorkerId !== undefined &&
            this.database.heartbeat(Number.parseInt(heartbeatMatch[1], 10), currentWorkerId),
        });
      }

      const eventMatch = url.pathname.match(/^\/v1\/jobs\/(\d+)\/events$/);
      if (request.method === "POST" && eventMatch?.[1]) {
        await this.event(
          Number.parseInt(eventMatch[1], 10),
          await body<AgentEvent>(request),
          workerId(request),
        );
        return json({ ok: true });
      }

      const usageMatch = url.pathname.match(/^\/v1\/jobs\/(\d+)\/usage$/);
      if (request.method === "POST" && usageMatch?.[1]) {
        const payload = await body<{ usage?: unknown; threadId?: unknown }>(request);
        if (!isAgentTokenUsage(payload.usage)) {
          return json({ error: "usage must contain non-negative integer token counts" }, 400);
        }
        if (payload.threadId !== undefined && typeof payload.threadId !== "string") {
          return json({ error: "threadId must be a string" }, 400);
        }
        return json({
          ok: true,
          recorded: this.database.recordUsage(
            Number.parseInt(usageMatch[1], 10),
            payload.usage,
            workerId(request),
            payload.threadId ?? null,
          ),
        });
      }

      const completionMatch = url.pathname.match(/^\/v1\/jobs\/(\d+)\/complete$/);
      if (request.method === "POST" && completionMatch?.[1]) {
        const payload = await body<AgentCompletion>(request);
        if (payload.assessment !== undefined && !isContextualAssessment(payload.assessment)) {
          return json({ error: "invalid contextual assessment" }, 400);
        }
        if (payload.usage !== undefined && !isAgentTokenUsage(payload.usage)) {
          return json({ error: "usage must contain non-negative integer token counts" }, 400);
        }
        await this.complete(Number.parseInt(completionMatch[1], 10), payload, workerId(request));
        return json({ ok: true });
      }

      const failureMatch = url.pathname.match(/^\/v1\/jobs\/(\d+)\/fail$/);
      if (request.method === "POST" && failureMatch?.[1]) {
        const payload = await body<{ error: string; usage?: unknown; threadId?: unknown }>(request);
        if (typeof payload.error !== "string") {
          return json({ error: "error must be a string" }, 400);
        }
        if (payload.usage !== undefined && !isAgentTokenUsage(payload.usage)) {
          return json({ error: "usage must contain non-negative integer token counts" }, 400);
        }
        if (payload.threadId !== undefined && typeof payload.threadId !== "string") {
          return json({ error: "threadId must be a string" }, 400);
        }
        await this.fail(
          Number.parseInt(failureMatch[1], 10),
          payload.error,
          workerId(request),
          payload.usage ?? null,
          payload.threadId ?? null,
        );
        return json({ ok: true });
      }

      const archiveResponse = await archiveRoute(request, url, this.database, this.config);
      if (archiveResponse) {
        return archiveResponse;
      }

      if (request.method === "GET" && url.pathname === "/v1/status") {
        return json(this.database.stats());
      }

      if (request.method === "GET" && url.pathname === "/v1/usage") {
        const rawChatId = url.searchParams.get("chat");
        const chatId = rawChatId === null ? null : Number(rawChatId);
        if (rawChatId !== null && (rawChatId.trim() === "" || !Number.isSafeInteger(chatId))) {
          return json({ error: "chat must be a valid chat ID" }, 400);
        }
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 100 : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
          return json({ error: "limit must be an integer from 1 to 1000" }, 400);
        }
        return json(this.database.usageReport(chatId, limit));
      }

      const telegramResponse = await telegramRoute(
        request,
        url,
        this.database,
        this.telegram,
        this.approvals,
      );
      if (telegramResponse) {
        return telegramResponse;
      }

      return json({ error: "not found" }, 404);
    } catch (error) {
      if (error instanceof ApprovalDeniedError) return json({ error: error.message }, 403);
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ level: "error", message, path: url.pathname }));
      return json({ error: message }, 500);
    }
  }

  private async event(jobId: number, event: AgentEvent, workerId?: string): Promise<void> {
    if (this.database.isJobCancelled(jobId)) {
      return;
    }
    const line = eventStatusLine(event);
    const status = this.database.appendStatus(jobId, line, event.threadId, workerId);
    if (status === null) {
      return;
    }
    const address = this.database.jobAddress(jobId);
    const thinkingMessageId = this.database.thinkingMessage(jobId);
    const now = Date.now();
    const document = workDocument(status);
    if (!document) {
      return;
    }
    if (address.chatType === "private") {
      if (this.#lastStreamDocument.get(jobId) === document) {
        return;
      }
      if (now - (this.#lastStreamEdit.get(jobId) ?? 0) < 1_500) {
        return;
      }
      await this.telegram.sendRichMessageDraft(address.chatId, document, {
        draftId: jobId,
        threadId: address.threadId,
        canStop: true,
      });
      this.#lastStreamEdit.set(jobId, now);
      this.#lastStreamDocument.set(jobId, document);
      return;
    }
    if (thinkingMessageId === null) {
      const message = await this.telegram.sendRich(address.chatId, document, {
        ...responseOptions(address.chatType, address.messageId, address.threadId),
      });
      this.database.setThinkingMessage(jobId, message.message_id);
      this.#lastStreamEdit.set(jobId, now);
      this.#lastStreamDocument.set(jobId, document);
      return;
    }
    if (this.#lastStreamDocument.get(jobId) === document) {
      return;
    }
    if (now - (this.#lastStreamEdit.get(jobId) ?? 0) >= 1_500) {
      const edited = await this.telegram.editRich(address.chatId, thinkingMessageId, document);
      if (edited === null) {
        const message = await this.telegram.sendRich(address.chatId, document, {
          ...responseOptions(address.chatType, address.messageId, address.threadId),
        });
        this.database.setThinkingMessage(jobId, message.message_id);
      }
      this.#lastStreamEdit.set(jobId, now);
      this.#lastStreamDocument.set(jobId, document);
    }
  }

  private async notifyUndeliveredSteers(jobId: number): Promise<void> {
    const address = this.database.jobAddress(jobId);
    for (const messageId of this.database.failPendingSteers?.(jobId) ?? []) {
      await this.telegram.sendRich(
        address.chatId,
        "Уточнение не передано: задача завершилась до его доставки.",
        { replyTo: messageId, threadId: address.threadId },
      );
    }
  }

  private async complete(
    jobId: number,
    completion: AgentCompletion,
    workerId?: string,
  ): Promise<void> {
    if (this.database.isJobCancelled(jobId)) {
      return;
    }
    const address = this.database.jobAddress(jobId);
    const thinkingMessageId = this.database.thinkingMessage(jobId);
    const appendedStatus = this.database.appendStatus(
      jobId,
      "Готово",
      completion.threadId,
      workerId,
    );
    if (
      appendedStatus === null &&
      (workerId === undefined || !this.database.isJobOwned(jobId, workerId))
    ) {
      return;
    }
    const status = appendedStatus ?? this.database.statusLog(jobId);
    if (status === null) {
      return;
    }
    const economyEnabled = this.isLeylobucksEnabled(address.userId);
    if (economyEnabled) {
      this.database.settleLeylobucksAssessment?.(
        jobId,
        completion.assessment ?? unavailableAssessment,
      );
    }
    const economy = economyEnabled ? (this.database.jobEconomy?.(jobId) ?? null) : null;
    const answer = economy
      ? `${completion.answer}\n\n${leylobucksFooter(economy)}`
      : completion.answer;
    const documents = completedDocuments(status, answer);
    let message: TelegramMessage;
    if (thinkingMessageId === null) {
      message = await this.telegram.sendRich(address.chatId, documents[0] ?? "", {
        ...responseOptions(address.chatType, address.messageId, address.threadId),
      });
    } else {
      // Keep the final answer at the bottom of the chat. In groups it replies to the user's
      // request even when other messages arrived while Codex was working; private chats omit
      // reply markers by design.
      message = await this.telegram.sendRich(address.chatId, documents[0] ?? "", {
        ...responseOptions(address.chatType, address.messageId, address.threadId),
      });
      await this.telegram.deleteMessage(address.chatId, thinkingMessageId);
    }
    this.database.recordOutboundMessage(jobId, message.message_id, completion.threadId);
    let replyTo = message.message_id;
    for (const document of documents.slice(1)) {
      const followUp = await this.telegram.sendRich(address.chatId, document, {
        ...responseOptions(address.chatType, replyTo, address.threadId),
      });
      this.database.recordOutboundMessage(jobId, followUp.message_id, completion.threadId);
      replyTo = followUp.message_id;
    }
    this.database.complete(
      jobId,
      message.message_id,
      completion.threadId,
      workerId,
      completion.usage ?? null,
      answer,
    );
    await this.notifyUndeliveredSteers(jobId);
    this.#lastStreamEdit.delete(jobId);
    this.#lastStreamDocument.delete(jobId);
  }

  private async fail(
    jobId: number,
    error: string,
    workerId?: string,
    usage: AgentCompletion["usage"] | null = null,
    threadId: string | null = null,
  ): Promise<void> {
    if (this.database.isJobCancelled(jobId)) {
      return;
    }
    if (workerId !== undefined && !this.database.isJobOwned(jobId, workerId)) {
      return;
    }
    const address = this.database.jobAddress(jobId);
    const thinkingMessageId = this.database.thinkingMessage(jobId);
    const currentThreadId = threadId ?? this.database.jobThreadId(jobId);
    const markdown = failedDocument(this.database.statusLog(jobId) ?? "", error);
    let message: { message_id: number };
    if (thinkingMessageId === null) {
      message = await this.telegram.sendRich(address.chatId, markdown, {
        ...responseOptions(address.chatType, address.messageId, address.threadId),
      });
    } else {
      const edited = await this.telegram.editRich(address.chatId, thinkingMessageId, markdown);
      message =
        edited ??
        (await this.telegram.sendRich(address.chatId, markdown, {
          ...responseOptions(address.chatType, address.messageId, address.threadId),
        }));
    }
    this.database.recordOutboundMessage(jobId, message.message_id, currentThreadId);
    this.database.fail(jobId, error.slice(0, 8_000), workerId, currentThreadId, usage);
    await this.notifyUndeliveredSteers(jobId);
    this.#lastStreamEdit.delete(jobId);
    this.#lastStreamDocument.delete(jobId);
  }
}
