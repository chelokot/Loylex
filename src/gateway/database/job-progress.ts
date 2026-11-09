import type { AgentJob } from "../../shared/types.ts";
import type { AgentTokenUsage } from "../../shared/usage.ts";
import { DatabaseJobs } from "./jobs.ts";
import { type JobOwnershipRow, jobLeaseDurationMs } from "./types.ts";

export abstract class DatabaseJobProgress extends DatabaseJobs {
  appendStatus(
    jobId: number,
    text: string,
    threadId: string | undefined,
    workerId?: string,
  ): string | null {
    const result = this.connection
      .query(`
        UPDATE jobs SET
          status_log = status_log || CASE WHEN status_log = '' THEN '' ELSE '\n\n' END || ?,
          codex_thread_id = COALESCE(?, codex_thread_id)
        WHERE id = ? AND state = 'running'
          AND (? IS NULL OR worker_id = ?)
          AND instr('\n\n' || status_log || '\n\n', '\n\n' || ? || '\n\n') = 0
      `)
      .run(text, threadId ?? null, jobId, workerId ?? null, workerId ?? null, text);
    if (result.changes === 0) {
      return null;
    }
    if (threadId) {
      this.connection
        .query(
          `UPDATE outbound_messages
           SET codex_thread_id = ?
           WHERE job_id = ? AND codex_thread_id IS NULL`,
        )
        .run(threadId, jobId);
    }
    return (
      this.connection
        .query<{ status_log: string }, [number]>("SELECT status_log FROM jobs WHERE id = ?")
        .get(jobId)?.status_log ?? null
    );
  }

  heartbeat(jobId: number, workerId: string): boolean {
    const result = this.connection
      .query(
        "UPDATE jobs SET lease_expires_at = ? WHERE id = ? AND state = 'running' AND worker_id = ?",
      )
      .run(Date.now() + jobLeaseDurationMs, jobId, workerId);
    return result.changes > 0;
  }

  isJobOwned(jobId: number, workerId: string): boolean {
    const row = this.connection
      .query<JobOwnershipRow, [number]>("SELECT state, worker_id FROM jobs WHERE id = ?")
      .get(jobId);
    return Boolean(row && row.state === "running" && row.worker_id === workerId);
  }

  thinkingMessage(jobId: number): number | null {
    return (
      this.connection
        .query<{ thinking_message_id: number | null }, [number]>(
          "SELECT thinking_message_id FROM jobs WHERE id = ?",
        )
        .get(jobId)?.thinking_message_id ?? null
    );
  }

  statusLog(jobId: number): string | null {
    return (
      this.connection
        .query<{ status_log: string }, [number]>("SELECT status_log FROM jobs WHERE id = ?")
        .get(jobId)?.status_log ?? null
    );
  }

  jobThreadId(jobId: number): string | null {
    return (
      this.connection
        .query<{ thread_id: string | null }, [number]>(
          "SELECT COALESCE(codex_thread_id, resume_thread_id) AS thread_id FROM jobs WHERE id = ?",
        )
        .get(jobId)?.thread_id ?? null
    );
  }

  setThinkingMessage(jobId: number, messageId: number): void {
    this.connection
      .query("UPDATE jobs SET thinking_message_id = ? WHERE id = ?")
      .run(messageId, jobId);
    this.recordOutboundMessage(jobId, messageId);
  }

  recordOutboundMessage(
    jobId: number,
    messageId: number,
    codexThreadId: string | null = null,
  ): void {
    const address = this.jobAddress(jobId);
    this.connection
      .query(`
        INSERT INTO outbound_messages (chat_id, message_id, job_id, codex_thread_id, sent_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, message_id) DO UPDATE SET
          job_id = excluded.job_id,
          codex_thread_id = COALESCE(excluded.codex_thread_id, outbound_messages.codex_thread_id),
          sent_at = excluded.sent_at
      `)
      .run(address.chatId, messageId, jobId, codexThreadId, Date.now());
  }

  activeJobsForMessage(chatId: number, messageId: number): { id: number }[] {
    const outbound = this.connection
      .query<{ job_id: number | null; codex_thread_id: string | null }, [number, number]>(
        "SELECT job_id, codex_thread_id FROM outbound_messages WHERE chat_id = ? AND message_id = ?",
      )
      .get(chatId, messageId);
    const sourceJob = this.connection
      .query<
        { id: number; codex_thread_id: string | null; resume_thread_id: string | null },
        [number, number]
      >(
        "SELECT id, codex_thread_id, resume_thread_id FROM jobs WHERE chat_id = ? AND message_id = ?",
      )
      .get(chatId, messageId);
    const targetJobId = outbound?.job_id ?? sourceJob?.id ?? -1;
    const targetThreadId =
      outbound?.codex_thread_id ??
      sourceJob?.codex_thread_id ??
      sourceJob?.resume_thread_id ??
      null;
    return this.connection
      .query<
        { id: number },
        [number, number, number, number, string | null, string | null, string | null]
      >(`
          SELECT DISTINCT id
          FROM jobs
          WHERE chat_id = ?
            AND state IN ('pending', 'running')
            AND (
              id = ?
              OR message_id = ?
              OR thinking_message_id = ?
              OR (
                ? IS NOT NULL
                AND (resume_thread_id = ? OR codex_thread_id = ?)
              )
            )
          ORDER BY id
        `)
      .all(
        chatId,
        targetJobId,
        messageId,
        messageId,
        targetThreadId,
        targetThreadId,
        targetThreadId,
      );
  }

  queueSteer(
    chatId: number,
    replyId: number,
    messageId: number,
    userId: number,
    prompt: string,
  ): number[] {
    return this.connection
      .transaction(() => {
        const jobs = this.activeJobsForMessage(chatId, replyId);
        for (const job of jobs) {
          this.connection
            .query(
              "INSERT OR IGNORE INTO job_steers (job_id, message_id, reply_message_id, user_id, prompt) VALUES (?, ?, ?, ?, ?)",
            )
            .run(job.id, messageId, replyId, userId, prompt);
        }
        return jobs.map((job) => job.id);
      })
      .immediate();
  }

  pendingSteers(
    jobId: number,
    workerId: string,
  ): { id: number; messageId: number; replyToMessageId: number; userId: number; prompt: string }[] {
    if (!this.isJobOwned(jobId, workerId)) return [];
    return this.connection
      .query<
        { id: number; messageId: number; replyToMessageId: number; userId: number; prompt: string },
        [number]
      >(
        "SELECT id, message_id AS messageId, reply_message_id AS replyToMessageId, user_id AS userId, prompt FROM job_steers WHERE job_id = ? AND state = 'pending' ORDER BY id LIMIT 20",
      )
      .all(jobId);
  }

  finishSteer(jobId: number, steerId: number, workerId: string, accepted: boolean): number | null {
    if (!this.isJobOwned(jobId, workerId)) return null;
    return (
      this.connection
        .query<{ message_id: number }, [string, number, number]>(
          "UPDATE job_steers SET state = ? WHERE id = ? AND job_id = ? AND state = 'pending' RETURNING message_id",
        )
        .get(accepted ? "accepted" : "failed", steerId, jobId)?.message_id ?? null
    );
  }

  failPendingSteers(jobId: number): number[] {
    return this.connection
      .query<{ message_id: number }, [number]>(
        "UPDATE job_steers SET state = 'failed' WHERE job_id = ? AND state = 'pending' AND EXISTS (SELECT 1 FROM jobs WHERE id = job_id AND state NOT IN ('pending', 'running')) RETURNING message_id",
      )
      .all(jobId)
      .map((row) => row.message_id);
  }

  cancelJobsForMessage(chatId: number, messageId: number): number[] {
    const transaction = this.connection.transaction(() => {
      const jobs = this.activeJobsForMessage(chatId, messageId);
      const cancelledAt = Date.now();
      for (const job of jobs) {
        this.connection
          .query(
            "UPDATE jobs SET state = 'cancelled', completed_at = ?, error = ?, worker_id = NULL, lease_expires_at = NULL WHERE id = ? AND state IN ('pending', 'running')",
          )
          .run(cancelledAt, "Остановлено пользователем", job.id);
      }
      return jobs.map((job) => job.id);
    });
    return transaction.immediate();
  }

  cancelJobsForDraft(chatId: number, draftId: number): number[] {
    const messageId = this.connection
      .query<{ message_id: number }, [number, number]>(
        "SELECT message_id FROM jobs WHERE id = ? AND chat_id = ?",
      )
      .get(draftId, chatId)?.message_id;
    return messageId === undefined ? [] : this.cancelJobsForMessage(chatId, messageId);
  }

  resumableThread(chatId: number, messageId: number): string | null {
    return (
      this.connection
        .query<{ thread_id: string | null }, [number, number, number]>(`
          SELECT COALESCE(j.codex_thread_id, j.resume_thread_id) AS thread_id
          FROM jobs AS j
          LEFT JOIN outbound_messages AS o
            ON o.chat_id = j.chat_id AND o.job_id = j.id
          WHERE j.chat_id = ?
            AND j.state IN ('failed', 'cancelled')
            AND (j.message_id = ? OR o.message_id = ?)
            AND COALESCE(j.codex_thread_id, j.resume_thread_id) IS NOT NULL
          ORDER BY j.created_at DESC, j.id DESC
          LIMIT 1
        `)
        .get(chatId, messageId, messageId)?.thread_id ?? null
    );
  }

  isJobCancelled(jobId: number): boolean {
    return Boolean(
      this.connection
        .query<{ value: number }, [number]>(
          "SELECT 1 AS value FROM jobs WHERE id = ? AND state = 'cancelled'",
        )
        .get(jobId),
    );
  }

  jobAddress(jobId: number): {
    chatId: number;
    chatType: AgentJob["chatType"];
    messageId: number;
    threadId: number | null;
    userId: number | null;
  } {
    const row = this.connection
      .query<
        {
          chat_id: number;
          chat_type: AgentJob["chatType"];
          message_id: number;
          message_thread_id: number | null;
          user_id: number | null;
        },
        [number]
      >("SELECT chat_id, chat_type, message_id, message_thread_id, user_id FROM jobs WHERE id = ?")
      .get(jobId);
    if (!row) {
      throw new Error(`Unknown job ${jobId}`);
    }
    return {
      chatId: row.chat_id,
      chatType: row.chat_type,
      messageId: row.message_id,
      threadId: row.message_thread_id,
      userId: row.user_id,
    };
  }

  recordUsage(
    jobId: number,
    usage: AgentTokenUsage,
    workerId?: string,
    codexThreadId?: string | null,
  ): boolean {
    const result = this.connection
      .query(`
        UPDATE jobs SET
          codex_thread_id = COALESCE(?, codex_thread_id),
          input_tokens = ?,
          cached_input_tokens = ?,
          cache_write_input_tokens = ?,
          output_tokens = ?,
          reasoning_output_tokens = ?,
          total_tokens = ?
        WHERE id = ?
          AND state IN ('pending', 'running', 'completed', 'failed', 'cancelled')
          AND (? IS NULL OR worker_id = ?)
      `)
      .run(
        codexThreadId ?? null,
        usage.inputTokens,
        usage.cachedInputTokens,
        usage.cacheWriteInputTokens,
        usage.outputTokens,
        usage.reasoningOutputTokens,
        usage.totalTokens,
        jobId,
        workerId ?? null,
        workerId ?? null,
      );
    return result.changes > 0;
  }

  complete(
    jobId: number,
    answerMessageId: number,
    codexThreadId: string,
    workerId?: string,
    usage: AgentTokenUsage | null = null,
    answer: string | null = null,
  ): boolean {
    const address = this.jobAddress(jobId);
    const transaction = this.connection.transaction(() => {
      const result = this.connection
        .query(`
          UPDATE jobs
          SET state = 'completed',
              completed_at = ?,
              codex_thread_id = COALESCE(?, codex_thread_id),
              thinking_message_id = COALESCE(?, thinking_message_id),
              answer = COALESCE(?, answer),
              input_tokens = COALESCE(?, input_tokens),
              cached_input_tokens = COALESCE(?, cached_input_tokens),
              cache_write_input_tokens = COALESCE(?, cache_write_input_tokens),
              output_tokens = COALESCE(?, output_tokens),
              reasoning_output_tokens = COALESCE(?, reasoning_output_tokens),
              total_tokens = COALESCE(?, total_tokens)
          WHERE id = ? AND state = 'running'
            AND (? IS NULL OR worker_id = ?)
        `)
        .run(
          Date.now(),
          codexThreadId,
          answerMessageId,
          answer,
          usage?.inputTokens ?? null,
          usage?.cachedInputTokens ?? null,
          usage?.cacheWriteInputTokens ?? null,
          usage?.outputTokens ?? null,
          usage?.reasoningOutputTokens ?? null,
          usage?.totalTokens ?? null,
          jobId,
          workerId ?? null,
          workerId ?? null,
        );
      if (result.changes === 0) {
        return false;
      }
      this.connection
        .query("UPDATE outbound_messages SET codex_thread_id = ? WHERE job_id = ?")
        .run(codexThreadId, jobId);
      this.connection
        .query("INSERT OR REPLACE INTO outbound_messages VALUES (?, ?, ?, ?, ?)")
        .run(address.chatId, answerMessageId, jobId, codexThreadId, Date.now());
      return true;
    });
    return transaction.immediate();
  }

  fail(
    jobId: number,
    error: string,
    workerId?: string,
    codexThreadId?: string | null,
    usage: AgentTokenUsage | null = null,
  ): void {
    const transaction = this.connection.transaction(() => {
      const result = this.connection
        .query(
          `
            UPDATE jobs SET
              state = 'failed',
              completed_at = ?,
              error = ?,
              codex_thread_id = COALESCE(?, codex_thread_id),
              input_tokens = COALESCE(?, input_tokens),
              cached_input_tokens = COALESCE(?, cached_input_tokens),
              cache_write_input_tokens = COALESCE(?, cache_write_input_tokens),
              output_tokens = COALESCE(?, output_tokens),
              reasoning_output_tokens = COALESCE(?, reasoning_output_tokens),
              total_tokens = COALESCE(?, total_tokens)
            WHERE id = ? AND state = 'running' AND (? IS NULL OR worker_id = ?)
          `,
        )
        .run(
          Date.now(),
          error,
          codexThreadId ?? null,
          usage?.inputTokens ?? null,
          usage?.cachedInputTokens ?? null,
          usage?.cacheWriteInputTokens ?? null,
          usage?.outputTokens ?? null,
          usage?.reasoningOutputTokens ?? null,
          usage?.totalTokens ?? null,
          jobId,
          workerId ?? null,
          workerId ?? null,
        );
      if (result.changes > 0 && codexThreadId) {
        this.connection
          .query(
            `UPDATE outbound_messages
             SET codex_thread_id = ?
             WHERE job_id = ? AND codex_thread_id IS NULL`,
          )
          .run(codexThreadId, jobId);
      }
    });
    transaction.immediate();
  }
}
