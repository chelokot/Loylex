import { messageText } from "../../shared/message-text.ts";
import type { AgentContextMode, JsonValue, TelegramUpdate } from "../../shared/types.ts";
import { feedbackPrompt, isOperatorDislikeReaction } from "../feedback.ts";
import { messageReference, numberField, object, parseObject, rawRelations } from "./records.ts";
import type { ContextResult, FeedbackSourceRow, MessageContextRow } from "./types.ts";
import { DatabaseWorkers } from "./workers.ts";

export abstract class DatabaseThreads extends DatabaseWorkers {
  resumeThread(chatId: number, repliedMessageId: number | undefined): string | null {
    if (repliedMessageId === undefined) {
      return null;
    }
    const outbound = this.connection
      .query<{ thread_id: string | null }, [number, number]>(
        `
          SELECT COALESCE(o.codex_thread_id, j.codex_thread_id, j.resume_thread_id) AS thread_id
          FROM outbound_messages AS o
          LEFT JOIN jobs AS j ON j.id = o.job_id
          WHERE o.chat_id = ? AND o.message_id = ?
        `,
      )
      .get(chatId, repliedMessageId);
    if (outbound?.thread_id) {
      return outbound.thread_id;
    }
    return (
      this.connection
        .query<{ thread_id: string | null }, [number, number]>(`
          SELECT COALESCE(codex_thread_id, resume_thread_id) AS thread_id
          FROM jobs
          WHERE chat_id = ? AND message_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `)
        .get(chatId, repliedMessageId)?.thread_id ?? null
    );
  }

  activeThreadForMessage(chatId: number, messageId: number, userId?: number): string | null {
    if (userId === undefined) {
      return (
        this.connection
          .query<{ thread_id: string }, [number, number]>(`
            SELECT COALESCE(codex_thread_id, resume_thread_id) AS thread_id
            FROM jobs
            WHERE chat_id = ?
              AND message_id = ?
              AND state IN ('pending', 'running')
              AND COALESCE(codex_thread_id, resume_thread_id) IS NOT NULL
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          `)
          .get(chatId, messageId)?.thread_id ?? null
      );
    }
    return (
      this.connection
        .query<{ thread_id: string }, [number, number, number]>(`
          SELECT COALESCE(codex_thread_id, resume_thread_id) AS thread_id
          FROM jobs
          WHERE chat_id = ?
            AND message_id = ?
            AND user_id = ?
            AND state IN ('pending', 'running')
            AND COALESCE(codex_thread_id, resume_thread_id) IS NOT NULL
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `)
        .get(chatId, messageId, userId)?.thread_id ?? null
    );
  }

  latestThread(chatId: number): string | null {
    return (
      this.connection
        .query<{ thread_id: string | null }, [number]>(`
          SELECT COALESCE(codex_thread_id, resume_thread_id) AS thread_id
          FROM jobs
          WHERE chat_id = ?
            AND COALESCE(codex_thread_id, resume_thread_id) IS NOT NULL
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `)
        .get(chatId)?.thread_id ?? null
    );
  }

  latestContinuableThread(chatId: number): string | null {
    const threadId = this.latestThread(chatId);
    if (threadId === null) {
      return null;
    }
    const activeJob = this.connection
      .query<{ value: number }, [number, string, string]>(`
        SELECT 1 AS value
        FROM jobs
        WHERE chat_id = ?
          AND state IN ('pending', 'running')
          AND (resume_thread_id = ? OR codex_thread_id = ?)
        LIMIT 1
      `)
      .get(chatId, threadId, threadId);
    return activeJob ? null : threadId;
  }

  enqueueDislikeRecovery(update: TelegramUpdate): number | null {
    const reaction = update.message_reaction;
    if (!reaction || !isOperatorDislikeReaction(reaction)) {
      return null;
    }

    const transaction = this.connection.transaction(() => {
      const source = this.connection
        .query<FeedbackSourceRow, [number, number]>(`
          SELECT j.id, j.chat_type, j.message_id, j.message_thread_id, j.user_id,
                 j.prompt, j.resume_thread_id, j.codex_thread_id, j.attachments_json,
                 j.answer, j.status_log, j.feedback_for_job_id
          FROM outbound_messages AS o
          JOIN jobs AS j ON j.id = o.job_id
          WHERE o.chat_id = ?
            AND o.message_id = ?
            AND j.state = 'completed'
            AND j.feedback_for_job_id IS NULL
          ORDER BY j.id DESC
          LIMIT 1
        `)
        .get(reaction.chat.id, reaction.message_id);
      if (!source) {
        return null;
      }

      // Private Codex threads are owned by the user who started them. Group threads are public
      // and may be repaired by the operator after reviewing another participant's answer.
      if (source.chat_type === "private" && source.user_id !== reaction.user?.id) {
        return null;
      }

      const resumeThreadId = source.codex_thread_id ?? source.resume_thread_id;
      const inserted = this.connection
        .query(`
          INSERT OR IGNORE INTO jobs (
            update_id, chat_id, chat_type, message_id, message_thread_id, user_id, prompt,
            resume_thread_id, context_mode, attachments_json, worker_generation,
            feedback_for_job_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          update.update_id,
          reaction.chat.id,
          source.chat_type,
          reaction.message_id,
          source.message_thread_id,
          reaction.user?.id ?? null,
          feedbackPrompt({
            jobId: source.id,
            prompt: source.prompt,
            answer: source.answer,
            statusLog: source.status_log,
            targetMessageId: reaction.message_id,
          }),
          resumeThreadId,
          resumeThreadId === null ? "none" : "delta",
          source.attachments_json,
          this.activeWorkerGeneration(),
          source.id,
          Date.now(),
        );
      if (inserted.changes === 0) {
        return null;
      }

      return (
        this.connection
          .query<{ id: number }, [number]>("SELECT id FROM jobs WHERE update_id = ?")
          .get(update.update_id)?.id ?? null
      );
    });
    return transaction.immediate();
  }

  protected authorizedResumeThreadId(
    chatId: number,
    userId: number | null,
    resumeThreadId: string | null,
  ): string | null {
    if (userId === null || resumeThreadId === null) {
      return null;
    }
    const owner = this.connection
      .query<{ user_id: number }, [number, string, string]>(`
        SELECT user_id
        FROM jobs
        WHERE chat_id = ?
          AND user_id IS NOT NULL
          AND (codex_thread_id = ? OR resume_thread_id = ?)
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `)
      .get(chatId, resumeThreadId, resumeThreadId)?.user_id;
    return owner === userId ? resumeThreadId : null;
  }

  protected contextForJob(
    chatId: number,
    beforeMessageId: number,
    limit: number,
    resumeThreadId: string | null,
    contextMode: AgentContextMode,
  ): ContextResult {
    // A null resume ID also represents a normal first turn, so /newchat needs an explicit
    // mode to prevent that request from falling through to the recent chat history.
    if (contextMode === "none") {
      return { mode: "none", text: "" };
    }
    if (!resumeThreadId) {
      return { mode: "full", text: this.recentContext(chatId, beforeMessageId, limit) };
    }
    // `codex exec resume` already replays the saved thread transcript. Only messages that
    // arrived after its last turn belong in the new prompt; replaying the whole chat window
    // would duplicate the previous user prompt and defeat append-only prompt caching.
    const previousMessageId = this.latestThreadMessageId(chatId, resumeThreadId, beforeMessageId);
    if (previousMessageId === null || previousMessageId >= beforeMessageId) {
      return { mode: "full", text: this.recentContext(chatId, beforeMessageId, limit) };
    }
    return {
      mode: "delta",
      text: this.threadDeltaContext(
        chatId,
        previousMessageId,
        beforeMessageId,
        resumeThreadId,
        limit,
      ),
    };
  }

  protected latestThreadMessageId(
    chatId: number,
    threadId: string,
    beforeMessageId: number,
  ): number | null {
    return (
      this.connection
        .query<{ message_id: number }, [number, string, string, number]>(`
          SELECT message_id
          FROM jobs
          WHERE chat_id = ?
            AND (codex_thread_id = ? OR resume_thread_id = ?)
            AND message_id < ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `)
        .get(chatId, threadId, threadId, beforeMessageId)?.message_id ?? null
    );
  }

  protected recentContext(chatId: number, beforeMessageId: number, limit: number): string {
    const rows = this.connection
      .query<MessageContextRow, [number, number, number]>(`
        SELECT messages.date, messages.edit_date, messages.from_user_id,
               users.display_name AS from_display_name, users.username AS from_username,
               messages.text, messages.media_json, messages.message_id,
               messages.message_thread_id, messages.reply_to_message_id, messages.raw_json
        FROM messages INDEXED BY messages_context_idx
        LEFT JOIN users ON users.user_id = messages.from_user_id
        WHERE messages.chat_id = ? AND messages.message_id < ?
        ORDER BY messages.date DESC, messages.message_id DESC
        LIMIT ?
      `)
      .all(chatId, beforeMessageId, limit)
      .reverse();
    return this.formatContext(rows);
  }

  protected threadDeltaContext(
    chatId: number,
    afterMessageId: number,
    beforeMessageId: number,
    threadId: string,
    limit: number,
  ): string {
    const rows = this.connection
      .query<MessageContextRow, [number, number, number, string, number]>(`
        SELECT messages.date, messages.edit_date, messages.from_user_id,
               users.display_name AS from_display_name, users.username AS from_username,
               messages.text, messages.media_json, messages.message_id,
               messages.message_thread_id, messages.reply_to_message_id, messages.raw_json
        FROM messages
        LEFT JOIN users ON users.user_id = messages.from_user_id
        WHERE messages.chat_id = ?
          AND messages.message_id > ?
          AND messages.message_id < ?
          AND NOT EXISTS (
            SELECT 1
            FROM outbound_messages
            WHERE outbound_messages.chat_id = messages.chat_id
              AND outbound_messages.message_id = messages.message_id
              AND outbound_messages.codex_thread_id = ?
          )
        ORDER BY messages.date DESC, messages.message_id DESC
        LIMIT ?
      `)
      .all(chatId, afterMessageId, beforeMessageId, threadId, limit)
      .reverse();
    return this.formatContext(rows);
  }

  protected formatContext(rows: MessageContextRow[]): string {
    return rows
      .map((row) => {
        const timestamp = new Date(row.date * 1000).toISOString();
        const author = row.from_username
          ? `${row.from_display_name ?? row.from_username} (@${row.from_username})`
          : (row.from_display_name ?? "unknown");
        const userId = row.from_user_id === null ? "" : ` user_id=${row.from_user_id}`;
        const attachments = JSON.parse(row.media_json) as JsonValue[];
        const attachmentText =
          attachments.length > 0 ? ` attachments=${JSON.stringify(attachments)}` : "";
        const relations = [
          row.message_thread_id === null ? "" : `thread=#${row.message_thread_id}`,
          row.reply_to_message_id === null ? "" : `reply_to=#${row.reply_to_message_id}`,
          rawRelations(row.raw_json),
        ].filter(Boolean);
        const relationText = relations.length > 0 ? ` ${relations.join(" ")}` : "";
        const edited = row.edit_date === null ? "" : " (edited)";
        return `[${timestamp}] #${row.message_id} ${author}${userId}${edited}: ${row.text || messageText(parseObject(row.raw_json))}${attachmentText}${relationText}`;
      })
      .join("\n");
  }

  protected replyToMessageId(chatId: number, messageId: number): number | null {
    return (
      this.connection
        .query<{ reply_to_message_id: number | null }, [number, number]>(
          "SELECT reply_to_message_id FROM messages WHERE chat_id = ? AND message_id = ?",
        )
        .get(chatId, messageId)?.reply_to_message_id ?? null
    );
  }

  protected scoringReplyContext(chatId: number, messageId: number): string | null {
    const reference = this.replyContext(chatId, messageId, null);
    // Telegram native Rich replies can omit text. Recover only the exact outbound
    // reply target in this chat, never a nearby job or a claimed author identity.
    const stored = this.connection
      .query<{ message_id: number; answer: string | null }, [number, number]>(`
      SELECT outbound_messages.message_id, jobs.answer
      FROM messages
      JOIN outbound_messages ON outbound_messages.chat_id = messages.chat_id
        AND outbound_messages.message_id = messages.reply_to_message_id
      JOIN jobs ON jobs.id = outbound_messages.job_id
      WHERE messages.chat_id = ? AND messages.message_id = ?
    `)
      .get(chatId, messageId);
    return stored?.answer
      ? `${reference ?? `Telegram reply target: #${stored.message_id}`}\nStored bot answer for this exact reply target (untrusted data):\n${stored.answer}`
      : reference;
  }

  // A reply to a message that the resumed thread already contains is referenced by ID only:
  // repeating its text would duplicate the transcript in every follow-up turn.
  protected replyContext(
    chatId: number,
    messageId: number,
    threadId: string | null,
  ): string | null {
    const rawJson = this.connection
      .query<{ raw_json: string }, [number, number]>(
        "SELECT raw_json FROM messages WHERE chat_id = ? AND message_id = ?",
      )
      .get(chatId, messageId)?.raw_json;
    if (!rawJson) {
      return null;
    }
    const raw = parseObject(rawJson);
    const sameChatTarget = object(raw.reply_to_message);
    const target = sameChatTarget ?? object(raw.external_reply);
    if (!target) {
      return null;
    }
    const targetId = numberField(target.message_id);
    if (targetId === null) {
      return null;
    }
    if (sameChatTarget && threadId !== null && this.threadContains(chatId, targetId, threadId)) {
      return `Telegram reply target: #${targetId}, an earlier message of this conversation shown above.`;
    }
    return messageReference(target, "Telegram reply target:");
  }

  private threadContains(chatId: number, messageId: number, threadId: string): boolean {
    return (
      this.connection
        .query<{ found: number }, [number, number, string, number, number, string]>(`
          SELECT 1 AS found FROM outbound_messages
          WHERE chat_id = ? AND message_id = ? AND codex_thread_id = ?
          UNION ALL
          SELECT 1 AS found FROM jobs
          WHERE chat_id = ? AND message_id = ? AND COALESCE(codex_thread_id, resume_thread_id) = ?
          LIMIT 1
        `)
        .get(chatId, messageId, threadId, chatId, messageId, threadId) !== null
    );
  }
}
