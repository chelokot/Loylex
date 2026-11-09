import { DatabaseJobProgress } from "./job-progress.ts";
import { usageTotals } from "./records.ts";
import type {
  UsageAggregateRow,
  UsageCodexThreadRow,
  UsageDayRow,
  UsageReport,
  UsageTelegramThreadRow,
  UsageThreadUserRow,
  UsageUserBreakdown,
  UsageUserRow,
} from "./types.ts";

export abstract class DatabaseUsage extends DatabaseJobProgress {
  usageReport(chatId: number | null = null, limit = 100): UsageReport {
    const safeLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 1_000) : 100;
    const filter = "(? IS NULL OR j.chat_id = ?)";
    const summary = this.connection
      .query<UsageAggregateRow, [number | null, number | null]>(`
        SELECT count(*) AS jobs,
               count(j.input_tokens) AS metered_jobs,
               sum(j.input_tokens) AS input_tokens,
               sum(j.cached_input_tokens) AS cached_input_tokens,
               sum(j.cache_write_input_tokens) AS cache_write_input_tokens,
               sum(j.output_tokens) AS output_tokens,
               sum(j.reasoning_output_tokens) AS reasoning_output_tokens,
               sum(j.total_tokens) AS total_tokens
        FROM jobs AS j
        WHERE ${filter}
      `)
      .get(chatId, chatId);

    const userRows = this.connection
      .query<UsageUserRow, [number | null, number | null, number]>(`
        SELECT j.user_id,
               u.username,
               u.display_name,
               count(*) AS jobs,
               count(j.input_tokens) AS metered_jobs,
               sum(j.input_tokens) AS input_tokens,
               sum(j.cached_input_tokens) AS cached_input_tokens,
               sum(j.cache_write_input_tokens) AS cache_write_input_tokens,
               sum(j.output_tokens) AS output_tokens,
               sum(j.reasoning_output_tokens) AS reasoning_output_tokens,
               sum(j.total_tokens) AS total_tokens
        FROM jobs AS j
        LEFT JOIN users AS u ON u.user_id = j.user_id
        WHERE ${filter}
        GROUP BY j.user_id, u.username, u.display_name
        ORDER BY COALESCE(sum(j.input_tokens), 0) DESC,
                 COALESCE(sum(j.output_tokens), 0) DESC,
                 j.user_id
        LIMIT ?
      `)
      .all(chatId, chatId, safeLimit);

    const telegramThreadRows = this.connection
      .query<UsageTelegramThreadRow, [number | null, number | null, number]>(`
        SELECT j.chat_id,
               c.chat_type,
               c.chat_title,
               j.message_thread_id,
               count(*) AS jobs,
               count(j.input_tokens) AS metered_jobs,
               sum(j.input_tokens) AS input_tokens,
               sum(j.cached_input_tokens) AS cached_input_tokens,
               sum(j.cache_write_input_tokens) AS cache_write_input_tokens,
               sum(j.output_tokens) AS output_tokens,
               sum(j.reasoning_output_tokens) AS reasoning_output_tokens,
               sum(j.total_tokens) AS total_tokens
        FROM jobs AS j
        LEFT JOIN chats AS c ON c.chat_id = j.chat_id
        WHERE ${filter}
        GROUP BY j.chat_id, c.chat_type, c.chat_title, j.message_thread_id
        ORDER BY COALESCE(sum(j.input_tokens), 0) DESC,
                 COALESCE(sum(j.output_tokens), 0) DESC,
                 j.chat_id,
                 j.message_thread_id
        LIMIT ?
      `)
      .all(chatId, chatId, safeLimit);

    const codexThreadRows = this.connection
      .query<UsageCodexThreadRow, [number | null, number | null, number]>(`
        SELECT COALESCE(j.codex_thread_id, j.resume_thread_id) AS thread_id,
               min(j.chat_id) AS chat_id,
               min(c.chat_title) AS chat_title,
               count(*) AS jobs,
               count(j.input_tokens) AS metered_jobs,
               sum(j.input_tokens) AS input_tokens,
               sum(j.cached_input_tokens) AS cached_input_tokens,
               sum(j.cache_write_input_tokens) AS cache_write_input_tokens,
               sum(j.output_tokens) AS output_tokens,
               sum(j.reasoning_output_tokens) AS reasoning_output_tokens,
               sum(j.total_tokens) AS total_tokens
        FROM jobs AS j
        LEFT JOIN chats AS c ON c.chat_id = j.chat_id
        WHERE ${filter} AND COALESCE(j.codex_thread_id, j.resume_thread_id) IS NOT NULL
        GROUP BY COALESCE(j.codex_thread_id, j.resume_thread_id)
        ORDER BY COALESCE(sum(j.input_tokens), 0) DESC,
                 COALESCE(sum(j.output_tokens), 0) DESC,
                 thread_id
        LIMIT ?
      `)
      .all(chatId, chatId, safeLimit);

    const threadIds = new Set(codexThreadRows.map((row) => row.thread_id));
    const threadUserRows = this.connection
      .query<UsageThreadUserRow, [number | null, number | null]>(`
        SELECT COALESCE(j.codex_thread_id, j.resume_thread_id) AS thread_id,
               j.user_id,
               u.username,
               u.display_name,
               count(*) AS jobs,
               count(j.input_tokens) AS metered_jobs,
               sum(j.input_tokens) AS input_tokens,
               sum(j.cached_input_tokens) AS cached_input_tokens,
               sum(j.cache_write_input_tokens) AS cache_write_input_tokens,
               sum(j.output_tokens) AS output_tokens,
               sum(j.reasoning_output_tokens) AS reasoning_output_tokens,
               sum(j.total_tokens) AS total_tokens
        FROM jobs AS j
        LEFT JOIN users AS u ON u.user_id = j.user_id
        WHERE ${filter} AND COALESCE(j.codex_thread_id, j.resume_thread_id) IS NOT NULL
        GROUP BY COALESCE(j.codex_thread_id, j.resume_thread_id),
                 j.user_id,
                 u.username,
                 u.display_name
        ORDER BY COALESCE(sum(j.input_tokens), 0) DESC,
                 COALESCE(sum(j.output_tokens), 0) DESC,
                 j.user_id
      `)
      .all(chatId, chatId)
      .filter((row) => threadIds.has(row.thread_id));

    const usersByThread = new Map<string, UsageUserBreakdown[]>();
    for (const row of threadUserRows) {
      const users = usersByThread.get(row.thread_id) ?? [];
      users.push({
        ...usageTotals(row),
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
      });
      usersByThread.set(row.thread_id, users);
    }

    const dayRows = this.connection
      .query<UsageDayRow, [number | null, number | null]>(`
        SELECT strftime('%Y-%m-%d', j.created_at / 1000, 'unixepoch') AS day,
               count(*) AS jobs,
               count(j.input_tokens) AS metered_jobs,
               sum(j.input_tokens) AS input_tokens,
               sum(j.cached_input_tokens) AS cached_input_tokens,
               sum(j.cache_write_input_tokens) AS cache_write_input_tokens,
               sum(j.output_tokens) AS output_tokens,
               sum(j.reasoning_output_tokens) AS reasoning_output_tokens,
               sum(j.total_tokens) AS total_tokens
        FROM jobs AS j
        WHERE ${filter}
        GROUP BY day
        ORDER BY day ASC
      `)
      .all(chatId, chatId);

    return {
      generatedAt: Date.now(),
      chatId,
      summary: usageTotals(
        summary ?? {
          jobs: 0,
          metered_jobs: 0,
          input_tokens: null,
          cached_input_tokens: null,
          cache_write_input_tokens: null,
          output_tokens: null,
          reasoning_output_tokens: null,
          total_tokens: null,
        },
      ),
      byUser: userRows.map((row) => ({
        ...usageTotals(row),
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
      })),
      byTelegramThread: telegramThreadRows.map((row) => ({
        ...usageTotals(row),
        chatId: row.chat_id,
        chatType: row.chat_type,
        chatTitle: row.chat_title,
        messageThreadId: row.message_thread_id,
      })),
      byCodexThread: codexThreadRows.map((row) => ({
        ...usageTotals(row),
        threadId: row.thread_id,
        chatId: row.chat_id,
        chatTitle: row.chat_title,
        users: usersByThread.get(row.thread_id) ?? [],
      })),
      byDay: dayRows.map((row) => ({ ...usageTotals(row), day: row.day })),
    };
  }
}
