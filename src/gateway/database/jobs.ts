import type { AgentContextMode, AgentJob, JsonValue, TelegramMessage } from "../../shared/types.ts";
import { DatabaseLeylobucks } from "./leylobucks.ts";
import { jobMedia } from "./records.ts";
import {
  type JobRow,
  type JobState,
  type JobSummary,
  type JobSummaryRow,
  jobLeaseDurationMs,
  type LeylobucksEnqueueResult,
  workerLeaseDurationMs,
} from "./types.ts";

export abstract class DatabaseJobs extends DatabaseLeylobucks {
  enqueueWithLeylobucks(
    updateId: number,
    message: TelegramMessage,
    prompt: string,
    _qualityText: string,
    resumeThreadId: string | null,
    contextMode: AgentContextMode = resumeThreadId === null ? "full" : "delta",
  ): LeylobucksEnqueueResult {
    const userId = message.from?.id;
    if (typeof userId !== "number" || !Number.isSafeInteger(userId)) {
      this.enqueue(updateId, message, prompt, resumeThreadId, contextMode);
      return {
        kind: "queued",
        economy: null,
      };
    }
    const authenticatedUserId: number = userId;

    const transaction = this.connection.transaction(() => {
      const existing = this.connection
        .query<{ id: number }, [number]>("SELECT id FROM jobs WHERE update_id = ?")
        .get(updateId);
      if (existing) {
        return { kind: "duplicate" as const };
      }

      // Contextual assessment is settled by the worker after inference, not by text length.
      const assessment = { qualityScore: 50, delta: 0 };
      const account = this.ensureLeylobucksAccount(authenticatedUserId);
      if (account.balance < 0) {
        return {
          kind: "blocked" as const,
          statusView: this.leylobucksStatusView(authenticatedUserId),
        };
      }

      const newBalance = account.balance + assessment.delta;
      if (!Number.isSafeInteger(newBalance)) {
        throw new Error("Loylebucks balance would exceed the safe integer range");
      }
      const actualDelta = assessment.delta;
      const catgirlMode = account.catgirl_messages > 0;
      const catgirlMessagesLeft = Math.max(account.catgirl_messages - (catgirlMode ? 1 : 0), 0);
      const now = Date.now();
      this.connection
        .query(`
          UPDATE leylobucks_accounts
          SET balance = ?, catgirl_messages = ?, updated_at = ?
          WHERE user_id = ?
        `)
        .run(newBalance, catgirlMessagesLeft, now, authenticatedUserId);

      const authorizedResumeThreadId =
        message.chat.type === "private"
          ? this.authorizedResumeThreadId(message.chat.id, authenticatedUserId, resumeThreadId)
          : resumeThreadId;
      const effectiveContextMode =
        contextMode === "none" ? "none" : authorizedResumeThreadId === null ? "full" : contextMode;
      const generation = this.activeWorkerGeneration();
      this.connection
        .query(`
          INSERT INTO jobs (
            update_id, chat_id, chat_type, message_id, message_thread_id, user_id, prompt,
            resume_thread_id, context_mode, attachments_json, worker_generation,
            economy_quality, economy_delta, economy_balance_after, catgirl_mode,
            catgirl_messages_left, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          updateId,
          message.chat.id,
          message.chat.type,
          message.message_id,
          message.message_thread_id ?? null,
          authenticatedUserId,
          prompt,
          authorizedResumeThreadId,
          effectiveContextMode,
          JSON.stringify(jobMedia(message)),
          generation,
          null,
          actualDelta,
          newBalance,
          catgirlMode ? 1 : 0,
          catgirlMessagesLeft,
          now,
        );
      const job = this.connection
        .query<{ id: number }, [number]>("SELECT id FROM jobs WHERE update_id = ?")
        .get(updateId);
      if (!job) {
        throw new Error(`Unable to create job for update ${updateId}`);
      }
      this.connection
        .query(`
          INSERT INTO leylobucks_transactions (
            user_id, delta, balance_after, reason, update_id, job_id, metadata_json, created_at
          ) VALUES (?, ?, ?, 'request', ?, ?, ?, ?)
        `)
        .run(
          authenticatedUserId,
          actualDelta,
          newBalance,
          updateId,
          job.id,
          JSON.stringify({ pendingAssessment: true }),
          now,
        );
      return {
        kind: "queued" as const,
        economy: {
          qualityScore: assessment.qualityScore,
          delta: actualDelta,
          balance: newBalance,
          catgirlMode,
          catgirlMessagesLeft,
        },
      };
    });
    return transaction.immediate();
  }

  enqueue(
    updateId: number,
    message: TelegramMessage,
    prompt: string,
    resumeThreadId: string | null,
    contextMode: AgentContextMode = resumeThreadId === null ? "full" : "delta",
  ): void {
    // Group and supergroup history is public to the chat, so every participant may continue
    // the shared Codex thread by replying to it. Keep the ownership boundary for private chats.
    const authorizedResumeThreadId =
      message.chat.type === "private"
        ? this.authorizedResumeThreadId(message.chat.id, message.from?.id ?? null, resumeThreadId)
        : resumeThreadId;
    const effectiveContextMode =
      contextMode === "none" ? "none" : authorizedResumeThreadId === null ? "full" : contextMode;
    const generation = this.activeWorkerGeneration();
    this.connection
      .query(`
        INSERT OR IGNORE INTO jobs (
          update_id, chat_id, chat_type, message_id, message_thread_id, user_id, prompt,
          resume_thread_id, context_mode, attachments_json, worker_generation, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        updateId,
        message.chat.id,
        message.chat.type,
        message.message_id,
        message.message_thread_id ?? null,
        message.from?.id ?? null,
        prompt,
        authorizedResumeThreadId,
        effectiveContextMode,
        JSON.stringify(jobMedia(message)),
        generation,
        Date.now(),
      );
  }

  claimNext(
    contextMessages: number,
    workerId: string | null = null,
    isLeylobucksEnabled: (userId: number | null) => boolean = () => true,
  ): AgentJob | null {
    const transaction = this.connection.transaction(() => {
      const now = Date.now();
      this.recoverExpiredLeasesInTransaction(now);
      const worker = workerId === null ? null : this.worker(workerId);
      if (
        workerId !== null &&
        ((!worker && this.hasRegisteredWorkers()) || worker?.state === "stopped")
      ) {
        return null;
      }
      if (worker?.state === "active") {
        this.connection
          .query(`
            UPDATE jobs SET worker_generation = ?
            WHERE state = 'pending' AND worker_generation <> ?
              AND NOT EXISTS (
                SELECT 1 FROM workers
                WHERE workers.generation = jobs.worker_generation
                  AND workers.state IN ('active', 'draining')
                  AND workers.last_seen_at >= ?
              )
          `)
          .run(worker.generation, worker.generation, now - workerLeaseDurationMs);
      }
      // A saved Codex thread has one append-only writer. Keep independent threads concurrent,
      // but leave the next turn for this thread pending until every earlier turn is finished.
      const row = worker
        ? this.connection
            .query<JobRow, [number]>(`
              SELECT candidate.*
              FROM jobs AS candidate
              WHERE candidate.state = 'pending'
                AND candidate.worker_generation = ?
                AND (
                  candidate.resume_thread_id IS NULL
                  OR NOT EXISTS (
                    SELECT 1
                    FROM jobs AS blocker
                    WHERE blocker.state IN ('pending', 'running')
                      AND (
                        blocker.resume_thread_id = candidate.resume_thread_id
                        OR blocker.codex_thread_id = candidate.resume_thread_id
                      )
                      AND (
                        blocker.created_at < candidate.created_at
                        OR (
                          blocker.created_at = candidate.created_at
                          AND blocker.id < candidate.id
                        )
                      )
                  )
                )
              ORDER BY candidate.created_at, candidate.id
              LIMIT 1
            `)
            .get(worker.generation)
        : this.connection
            .query<JobRow, []>(`
              SELECT candidate.*
              FROM jobs AS candidate
              WHERE candidate.state = 'pending'
                AND (
                  candidate.resume_thread_id IS NULL
                  OR NOT EXISTS (
                    SELECT 1
                    FROM jobs AS blocker
                    WHERE blocker.state IN ('pending', 'running')
                      AND (
                        blocker.resume_thread_id = candidate.resume_thread_id
                        OR blocker.codex_thread_id = candidate.resume_thread_id
                      )
                      AND (
                        blocker.created_at < candidate.created_at
                        OR (
                          blocker.created_at = candidate.created_at
                          AND blocker.id < candidate.id
                        )
                      )
                  )
                )
              ORDER BY candidate.created_at, candidate.id
              LIMIT 1
            `)
            .get();
      if (!row) {
        return null;
      }
      this.connection
        .query(
          "UPDATE jobs SET state = 'running', claimed_at = ?, worker_id = ?, lease_expires_at = ? WHERE id = ?",
        )
        .run(now, workerId, workerId === null ? null : now + jobLeaseDurationMs, row.id);
      return row;
    });
    const row = transaction.immediate();
    if (!row) {
      return null;
    }
    const contextStartedAt = performance.now();
    const context = this.contextForJob(
      row.chat_id,
      row.message_id,
      contextMessages,
      row.resume_thread_id,
      row.context_mode,
    );
    console.log(
      JSON.stringify({
        event: "job_context_ready",
        jobId: row.id,
        contextMs: Math.round(performance.now() - contextStartedAt),
      }),
    );
    const leylobucksEnabled = isLeylobucksEnabled(row.user_id);
    return {
      id: row.id,
      updateId: row.update_id,
      chatId: row.chat_id,
      chatType: row.chat_type,
      messageId: row.message_id,
      messageThreadId: row.message_thread_id,
      userId: row.user_id,
      prompt: row.prompt,
      resumeThreadId: row.resume_thread_id,
      context: context.text,
      ...(leylobucksEnabled &&
      row.economy_quality === null &&
      row.economy_balance_after !== null &&
      row.context_mode !== "none"
        ? {
            assessmentContext: this.contextForJob(
              row.chat_id,
              row.message_id,
              contextMessages,
              null,
              "full",
            ).text,
            assessmentReplyContext: this.scoringReplyContext(row.chat_id, row.message_id),
          }
        : {}),
      contextMode: context.mode,
      replyToMessageId: this.replyToMessageId(row.chat_id, row.message_id),
      replyContext:
        context.mode === "none" && row.resume_thread_id === null
          ? null
          : this.replyContext(row.chat_id, row.message_id, row.resume_thread_id),
      attachments: JSON.parse(row.attachments_json) as JsonValue[],
      ...(!leylobucksEnabled || row.economy_balance_after === null
        ? {}
        : {
            leylobucks: {
              pendingAssessment: row.economy_quality === null,
              qualityScore: row.economy_quality ?? 50,
              delta: row.economy_delta,
              balance: row.economy_balance_after,
              catgirlMode: row.catgirl_mode === 1,
              catgirlMessagesLeft: row.catgirl_messages_left,
            },
          }),
    };
  }

  listRecentJobs(chatId: number, limit = 5): JobSummary[] {
    const rows = this.connection
      .query<JobSummaryRow, [number, number]>(`
        SELECT id, chat_id, chat_type, message_id, prompt, state,
               created_at, completed_at, thinking_message_id, codex_thread_id, resume_thread_id
        FROM jobs
        WHERE chat_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(chatId, limit);
    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      chatType: row.chat_type,
      messageId: row.message_id,
      prompt: row.prompt,
      state: row.state as JobState,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      thinkingMessageId: row.thinking_message_id,
      canResume:
        (row.state === "failed" || row.state === "cancelled") &&
        (row.codex_thread_id !== null || row.resume_thread_id !== null),
    }));
  }
}
