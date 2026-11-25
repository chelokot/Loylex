import { DatabaseUsage } from "./database/usage.ts";

export {
  type ArchivedMedia,
  type ArchivedMessage,
  type JobState,
  type JobSummary,
  jobLeaseDurationMs,
  type LeylobucksEnqueueResult,
  type LeylobucksJobEconomy,
  type LeylobucksPurchaseResult,
  type LeylobucksQuizAction,
  type LeylobucksQuizQuestionView,
  type LeylobucksQuizReview,
  type LeylobucksStatus,
  type LeylobucksTestBumpResult,
  type SearchResult,
  type UsageCodexThreadBreakdown,
  type UsageDayBreakdown,
  type UsageReport,
  type UsageTelegramThreadBreakdown,
  type UsageTotals,
  type UsageUserBreakdown,
  workerLeaseDurationMs,
} from "./database/types.ts";

export class LoylexDatabase extends DatabaseUsage {
  emojiPack(userId: number): string | undefined {
    return this.connection
      .query<{ pack: string }, [number]>("SELECT pack FROM user_emoji_packs WHERE user_id = ?")
      .get(userId)?.pack;
  }

  setEmojiPack(userId: number, pack: string | null): void {
    if (pack === null) {
      this.connection.run("DELETE FROM user_emoji_packs WHERE user_id = ?", [userId]);
      return;
    }
    this.connection.run(
      `INSERT INTO user_emoji_packs (user_id, pack) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET pack = excluded.pack`,
      [userId, pack],
    );
  }

  progressEnabled(userId: number | null | undefined): boolean {
    if (userId == null) return true;
    return (
      this.connection
        .query<{ enabled: number }, [number]>("SELECT enabled FROM user_progress WHERE user_id = ?")
        .get(userId)?.enabled !== 0
    );
  }

  toggleProgress(userId: number): boolean {
    const row = this.connection
      .query<{ enabled: number }, [number]>(`
        INSERT INTO user_progress (user_id, enabled) VALUES (?, 0)
        ON CONFLICT(user_id) DO UPDATE SET enabled = 1 - enabled
        RETURNING enabled
      `)
      .get(userId);
    return row?.enabled === 1;
  }
}
