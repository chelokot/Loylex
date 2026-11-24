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
