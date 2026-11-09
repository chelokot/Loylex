import type {
  AgentContextMode,
  AgentJob,
  AgentJobLeylobucks,
  JsonObject,
  JsonValue,
} from "../../shared/types.ts";
import type { AgentTokenUsage } from "../../shared/usage.ts";
import type { LeylobucksPackage, LeylobucksQuizQuestion } from "../leylobucks.ts";

export type JobState = "pending" | "running" | "completed" | "failed" | "cancelled";

export type UsageTotals = AgentTokenUsage & {
  jobs: number;
  meteredJobs: number;
  unmeteredJobs: number;
  nonCachedInputTokens: number;
};

export type UsageUserBreakdown = UsageTotals & {
  userId: number | null;
  username: string | null;
  displayName: string | null;
};

export type UsageTelegramThreadBreakdown = UsageTotals & {
  chatId: number;
  chatType: AgentJob["chatType"] | null;
  chatTitle: string | null;
  messageThreadId: number | null;
};

export type UsageCodexThreadBreakdown = UsageTotals & {
  threadId: string;
  chatId: number | null;
  chatTitle: string | null;
  users: UsageUserBreakdown[];
};

export type UsageDayBreakdown = UsageTotals & { day: string };

export type UsageReport = {
  generatedAt: number;
  chatId: number | null;
  summary: UsageTotals;
  byUser: UsageUserBreakdown[];
  byTelegramThread: UsageTelegramThreadBreakdown[];
  byCodexThread: UsageCodexThreadBreakdown[];
  byDay: UsageDayBreakdown[];
};

export const jobLeaseDurationMs = 60_000;

export const workerLeaseDurationMs = 15_000;

export type JobSummary = {
  id: number;
  chatId: number;
  chatType: AgentJob["chatType"];
  messageId: number;
  prompt: string;
  state: JobState;
  createdAt: number;
  completedAt: number | null;
  thinkingMessageId: number | null;
  canResume: boolean;
};

export type JobRow = {
  id: number;
  update_id: number;
  chat_id: number;
  chat_type: AgentJob["chatType"];
  message_id: number;
  message_thread_id: number | null;
  user_id: number | null;
  prompt: string;
  resume_thread_id: string | null;
  context_mode: AgentContextMode;
  attachments_json: string;
  worker_generation: number;
  economy_quality: number | null;
  economy_delta: number;
  economy_balance_after: number | null;
  catgirl_mode: number;
  catgirl_messages_left: number;
};

export type LeylobucksAccountRow = {
  user_id: number;
  balance: number;
  catgirl_messages: number;
  next_quiz_size: number;
  quiz_attempt: number;
  enabled: number;
};

export type LeylobucksQuizSessionRow = {
  user_id: number;
  question_count: number;
  questions_json: string;
  answers_json: string;
  question_index: number;
  correct_count: number;
  attempt: number;
};

export type LeylobucksQuizQuestionView = Omit<LeylobucksQuizQuestion, "id" | "difficulty">;

export type LeylobucksQuizReview = {
  question: LeylobucksQuizQuestionView;
  answerIndex: number | null;
  correct: boolean;
};

export type LeylobucksStatus = {
  userId: number;
  balance: number;
  catgirlMessages: number;
  nextQuizSize: number;
  quiz: {
    questionCount: number;
    questionIndex: number;
    correctCount: number;
    question: LeylobucksQuizQuestionView;
  } | null;
};

export type LeylobucksPurchaseResult = {
  status: "purchased" | "invalid_package" | "in_debt" | "insufficient";
  package: LeylobucksPackage | null;
  statusView: LeylobucksStatus;
};

export type LeylobucksTestBumpResult = {
  amount: number;
  statusView: LeylobucksStatus;
};

export type LeylobucksQuizAction = {
  kind: "started" | "in_progress" | "next" | "invalid_answer" | "passed" | "failed";
  status: LeylobucksStatus;
  question: LeylobucksQuizQuestionView | null;
  review: LeylobucksQuizReview[] | null;
  correct: boolean | null;
  questionCount: number | null;
  correctCount: number | null;
  nextQuizSize: number | null;
};

export type LeylobucksJobEconomy = AgentJobLeylobucks;

export type LeylobucksEnqueueResult =
  | { kind: "queued"; economy: LeylobucksJobEconomy | null }
  | { kind: "duplicate" }
  | { kind: "blocked"; statusView: LeylobucksStatus };

export type WorkerRow = {
  worker_id: string;
  generation: number;
  state: "active" | "draining" | "stopped";
  registered_at: number;
  last_seen_at: number;
};

export type WorkerRuntimeRow = {
  active_worker_id: string | null;
  active_generation: number;
};

export type MessageContextRow = {
  date: number;
  edit_date: number | null;
  from_user_id: number | null;
  from_display_name: string | null;
  from_username: string | null;
  text: string | null;
  media_json: string;
  message_id: number;
  message_thread_id: number | null;
  reply_to_message_id: number | null;
  raw_json: string;
};

export type ContextResult = {
  mode: AgentContextMode;
  text: string;
};

export type JobSummaryRow = {
  id: number;
  chat_id: number;
  chat_type: AgentJob["chatType"];
  message_id: number;
  prompt: string;
  state: string;
  created_at: number;
  completed_at: number | null;
  thinking_message_id: number | null;
  codex_thread_id: string | null;
  resume_thread_id: string | null;
};

export type JobOwnershipRow = {
  state: string;
  worker_id: string | null;
};

export type UsageAggregateRow = {
  jobs: number;
  metered_jobs: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
};

export type UsageUserRow = UsageAggregateRow & {
  user_id: number | null;
  username: string | null;
  display_name: string | null;
};

export type UsageTelegramThreadRow = UsageAggregateRow & {
  chat_id: number;
  chat_type: AgentJob["chatType"] | null;
  chat_title: string | null;
  message_thread_id: number | null;
};

export type UsageCodexThreadRow = UsageAggregateRow & {
  thread_id: string;
  chat_id: number | null;
  chat_title: string | null;
};

export type UsageThreadUserRow = UsageUserRow & { thread_id: string };

export type UsageDayRow = UsageAggregateRow & { day: string };

export type SearchResult = {
  chatId: number;
  messageId: number;
  date: number;
  userId: number | null;
  author: string;
  text: string;
  forwardOrigin?: JsonObject;
};

export type ArchivedMedia = {
  chatId: number;
  messageId: number;
  date: number;
  source: "bot_api" | "telegram_export";
  media: JsonValue[];
};

export type ArchivedMessage = {
  chatId: number;
  messageId: number;
  date: number;
  userId: number | null;
  author: string;
  text: string;
  replyToMessageId: number | null;
  mediaGroupId: string | null;
  source: "bot_api" | "telegram_export";
  media: JsonValue[];
  raw: JsonObject;
  forwardOrigin?: JsonObject;
};

export type ReadQueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
};

export type SearchRow = {
  chat_id: number;
  message_id: number;
  date: number;
  from_user_id: number | null;
  from_display_name: string | null;
  from_username: string | null;
  text: string | null;
  raw_json: string;
};

export type ArchivedMessageRow = {
  chat_id: number;
  message_id: number;
  date: number;
  from_user_id: number | null;
  from_display_name: string | null;
  from_username: string | null;
  text: string | null;
  reply_to_message_id: number | null;
  media_group_id: string | null;
  media_json: string;
  raw_json: string;
  source: string;
};

export type FeedbackSourceRow = {
  id: number;
  chat_type: AgentJob["chatType"];
  message_id: number;
  message_thread_id: number | null;
  user_id: number | null;
  prompt: string;
  resume_thread_id: string | null;
  codex_thread_id: string | null;
  attachments_json: string;
  answer: string | null;
  status_log: string;
  feedback_for_job_id: number | null;
};

export type UnknownRecord = Record<string, unknown>;
