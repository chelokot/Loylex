import {
  createLeylobucksQuiz,
  type LeylobucksQuizQuestion,
  leylobucksInitialQuizSize,
  leylobucksPackages,
  quizAnswerIndex,
  quizPassingScore,
} from "../leylobucks.ts";
import { leylobucksQuestionView, parseQuizAnswers, quizReview } from "./records.ts";
import { DatabaseThreads } from "./threads.ts";
import type {
  LeylobucksAccountRow,
  LeylobucksJobEconomy,
  LeylobucksPurchaseResult,
  LeylobucksQuizAction,
  LeylobucksQuizSessionRow,
  LeylobucksStatus,
  LeylobucksTestBumpResult,
} from "./types.ts";

export abstract class DatabaseLeylobucks extends DatabaseThreads {
  protected ensureLeylobucksAccount(userId: number, now = Date.now()): LeylobucksAccountRow {
    this.connection
      .query(`
        INSERT OR IGNORE INTO leylobucks_accounts (
          user_id, balance, catgirl_messages, next_quiz_size, quiz_attempt, updated_at
        ) VALUES (?, 0, 0, ?, 0, ?)
      `)
      .run(userId, leylobucksInitialQuizSize, now);
    const account = this.connection
      .query<LeylobucksAccountRow, [number]>(`
        SELECT user_id, balance, catgirl_messages, next_quiz_size, quiz_attempt, enabled
        FROM leylobucks_accounts
        WHERE user_id = ?
      `)
      .get(userId);
    if (!account) {
      throw new Error(`Unable to create Loylebucks account for user ${userId}`);
    }
    return account;
  }

  protected leylobucksStatusView(userId: number): LeylobucksStatus {
    const account = this.connection
      .query<LeylobucksAccountRow, [number]>(`
        SELECT user_id, balance, catgirl_messages, next_quiz_size, quiz_attempt, enabled
        FROM leylobucks_accounts
        WHERE user_id = ?
      `)
      .get(userId) ?? {
      user_id: userId,
      balance: 0,
      catgirl_messages: 0,
      next_quiz_size: leylobucksInitialQuizSize,
      quiz_attempt: 0,
      enabled: 1,
    };
    const session = this.connection
      .query<LeylobucksQuizSessionRow, [number]>(`
        SELECT user_id, question_count, questions_json, answers_json, question_index, correct_count, attempt
        FROM leylobucks_quiz_sessions
        WHERE user_id = ?
      `)
      .get(userId);
    let quiz: LeylobucksStatus["quiz"] = null;
    if (session) {
      const questions = JSON.parse(session.questions_json) as LeylobucksQuizQuestion[];
      const question = questions[session.question_index];
      if (question) {
        quiz = {
          questionCount: session.question_count,
          questionIndex: session.question_index,
          correctCount: session.correct_count,
          question: leylobucksQuestionView(question),
        };
      }
    }
    return {
      userId: account.user_id,
      balance: account.balance,
      catgirlMessages: account.catgirl_messages,
      nextQuizSize: account.next_quiz_size,
      quiz,
    };
  }

  leylobucksStatus(userId: number): LeylobucksStatus {
    return this.leylobucksStatusView(userId);
  }

  isLeylobucksEnabled(userId: number): boolean {
    return (
      (this.connection
        .query<{ enabled: number }, [number]>(
          "SELECT enabled FROM leylobucks_accounts WHERE user_id = ?",
        )
        .get(userId)?.enabled ?? 1) === 1
    );
  }

  setLeylobucksEnabled(userId: number, enabled: boolean): void {
    const transaction = this.connection.transaction(() => {
      this.ensureLeylobucksAccount(userId);
      this.connection
        .query("UPDATE leylobucks_accounts SET enabled = ?, updated_at = ? WHERE user_id = ?")
        .run(enabled ? 1 : 0, Date.now(), userId);
    });
    transaction.immediate();
  }

  testBumpLeylobucks(userId: number, amount: number): LeylobucksTestBumpResult {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error("Test Loylebucks bump amount must be a positive safe integer");
    }
    const transaction = this.connection.transaction(() => {
      const account = this.ensureLeylobucksAccount(userId);
      const balance = account.balance + amount;
      if (!Number.isSafeInteger(balance)) {
        throw new Error("Test Loylebucks bump would exceed the safe integer range");
      }
      const now = Date.now();
      this.connection
        .query(`
          UPDATE leylobucks_accounts
          SET balance = ?, updated_at = ?
          WHERE user_id = ?
        `)
        .run(balance, now, userId);
      this.connection
        .query(`
          INSERT INTO leylobucks_transactions (
            user_id, delta, balance_after, reason, update_id, job_id, metadata_json, created_at
          ) VALUES (?, ?, ?, 'test_bump', NULL, NULL, ?, ?)
        `)
        .run(userId, amount, balance, JSON.stringify({ testOnly: true }), now);
      return { amount, statusView: this.leylobucksStatusView(userId) };
    });
    return transaction.immediate();
  }

  purchaseLeylobucks(userId: number, cost: number): LeylobucksPurchaseResult {
    const transaction = this.connection.transaction(() => {
      const package_ = leylobucksPackages.find((item) => item.cost === cost) ?? null;
      const account = this.ensureLeylobucksAccount(userId);
      if (!package_) {
        return {
          status: "invalid_package" as const,
          package: null,
          statusView: this.leylobucksStatusView(userId),
        };
      }
      if (account.balance < 0) {
        return {
          status: "in_debt" as const,
          package: package_,
          statusView: this.leylobucksStatusView(userId),
        };
      }
      if (account.balance < package_.cost) {
        return {
          status: "insufficient" as const,
          package: package_,
          statusView: this.leylobucksStatusView(userId),
        };
      }
      const now = Date.now();
      const balance = account.balance - package_.cost;
      const catgirlMessages = account.catgirl_messages + package_.messages;
      this.connection
        .query(`
          UPDATE leylobucks_accounts
          SET balance = ?, catgirl_messages = ?, updated_at = ?
          WHERE user_id = ?
        `)
        .run(balance, catgirlMessages, now, userId);
      this.connection
        .query(`
          INSERT INTO leylobucks_transactions (
            user_id, delta, balance_after, reason, update_id, job_id, metadata_json, created_at
          ) VALUES (?, ?, ?, 'purchase', NULL, NULL, ?, ?)
        `)
        .run(userId, -package_.cost, balance, JSON.stringify({ messages: package_.messages }), now);
      return {
        status: "purchased" as const,
        package: package_,
        statusView: this.leylobucksStatusView(userId),
      };
    });
    return transaction.immediate();
  }

  quizLeylobucks(userId: number, answer: string | null = null): LeylobucksQuizAction {
    const transaction = this.connection.transaction(() => {
      const account = this.ensureLeylobucksAccount(userId);
      let session = this.connection
        .query<LeylobucksQuizSessionRow, [number]>(`
          SELECT user_id, question_count, questions_json, answers_json, question_index, correct_count, attempt
          FROM leylobucks_quiz_sessions
          WHERE user_id = ?
        `)
        .get(userId);
      if (!session) {
        const now = Date.now();
        const attempt = account.quiz_attempt + 1;
        const createdQuestions = createLeylobucksQuiz(userId, attempt, account.next_quiz_size);
        this.connection
          .query(`
            INSERT INTO leylobucks_quiz_sessions (
              user_id, question_count, questions_json, answers_json, question_index, correct_count, attempt, started_at
            ) VALUES (?, ?, ?, '[]', 0, 0, ?, ?)
          `)
          .run(userId, createdQuestions.length, JSON.stringify(createdQuestions), attempt, now);
        this.connection
          .query(
            "UPDATE leylobucks_accounts SET quiz_attempt = ?, updated_at = ? WHERE user_id = ?",
          )
          .run(attempt, now, userId);
        session = this.connection
          .query<LeylobucksQuizSessionRow, [number]>(`
            SELECT user_id, question_count, questions_json, answers_json, question_index, correct_count, attempt
            FROM leylobucks_quiz_sessions
            WHERE user_id = ?
          `)
          .get(userId);
        if (!session) {
          throw new Error(`Unable to start Loylebucks quiz for user ${userId}`);
        }
        const storedQuestions = JSON.parse(session.questions_json) as LeylobucksQuizQuestion[];
        return {
          kind: "started" as const,
          status: this.leylobucksStatusView(userId),
          question: storedQuestions[0] ? leylobucksQuestionView(storedQuestions[0]) : null,
          review: null,
          correct: null,
          questionCount: session.question_count,
          correctCount: 0,
          nextQuizSize: null,
        };
      }

      const questions = JSON.parse(session.questions_json) as LeylobucksQuizQuestion[];
      const question = questions[session.question_index];
      if (!question) {
        throw new Error(`Invalid Loylebucks quiz session for user ${userId}`);
      }
      if (answer === null) {
        return {
          kind: "in_progress" as const,
          status: this.leylobucksStatusView(userId),
          question: leylobucksQuestionView(question),
          review: null,
          correct: null,
          questionCount: session.question_count,
          correctCount: session.correct_count,
          nextQuizSize: null,
        };
      }

      const answerIndex = quizAnswerIndex(answer, question);
      if (answerIndex === null) {
        return {
          kind: "invalid_answer" as const,
          status: this.leylobucksStatusView(userId),
          question: leylobucksQuestionView(question),
          review: null,
          correct: null,
          questionCount: session.question_count,
          correctCount: session.correct_count,
          nextQuizSize: null,
        };
      }

      const isCorrect = answerIndex === question.correctIndex;
      const correctCount = session.correct_count + (isCorrect ? 1 : 0);
      const questionIndex = session.question_index + 1;
      const answers = parseQuizAnswers(session.answers_json);
      answers[session.question_index] = answerIndex;
      if (questionIndex < session.question_count) {
        this.connection
          .query(`
            UPDATE leylobucks_quiz_sessions
            SET answers_json = ?, question_index = ?, correct_count = ?
            WHERE user_id = ?
          `)
          .run(JSON.stringify(answers), questionIndex, correctCount, userId);
        const nextQuestion = questions[questionIndex];
        return {
          kind: "next" as const,
          status: this.leylobucksStatusView(userId),
          question: nextQuestion ? leylobucksQuestionView(nextQuestion) : null,
          review: null,
          correct: isCorrect,
          questionCount: session.question_count,
          correctCount,
          nextQuizSize: null,
        };
      }

      const now = Date.now();
      const passingScore = quizPassingScore(session.question_count);
      const review = quizReview(questions, answers);
      if (correctCount >= passingScore) {
        const balanceAfterQuiz = account.balance < 0 ? 0 : account.balance;
        const quizDelta = balanceAfterQuiz - account.balance;
        this.connection
          .query(`
            UPDATE leylobucks_accounts
            SET balance = ?, next_quiz_size = ?, updated_at = ?
            WHERE user_id = ?
          `)
          .run(balanceAfterQuiz, leylobucksInitialQuizSize, now, userId);
        this.connection
          .query(`
            INSERT INTO leylobucks_transactions (
              user_id, delta, balance_after, reason, update_id, job_id, metadata_json, created_at
            ) VALUES (?, ?, ?, 'quiz_passed', NULL, NULL, ?, ?)
          `)
          .run(
            userId,
            quizDelta,
            balanceAfterQuiz,
            JSON.stringify({ questions: session.question_count, correct: correctCount }),
            now,
          );
        this.connection.query("DELETE FROM leylobucks_quiz_sessions WHERE user_id = ?").run(userId);
        return {
          kind: "passed" as const,
          status: this.leylobucksStatusView(userId),
          question: null,
          review,
          correct: isCorrect,
          questionCount: session.question_count,
          correctCount,
          nextQuizSize: null,
        };
      }

      const nextQuizSize = session.question_count + 1;
      this.connection
        .query(`
          UPDATE leylobucks_accounts
          SET next_quiz_size = ?, updated_at = ?
          WHERE user_id = ?
        `)
        .run(nextQuizSize, now, userId);
      this.connection.query("DELETE FROM leylobucks_quiz_sessions WHERE user_id = ?").run(userId);
      return {
        kind: "failed" as const,
        status: this.leylobucksStatusView(userId),
        question: null,
        review,
        correct: isCorrect,
        questionCount: session.question_count,
        correctCount,
        nextQuizSize,
      };
    });
    return transaction.immediate();
  }

  jobEconomy(jobId: number): LeylobucksJobEconomy | null {
    const row = this.connection
      .query<
        {
          economy_quality: number | null;
          economy_delta: number;
          economy_balance_after: number | null;
          catgirl_mode: number;
          catgirl_messages_left: number;
        },
        [number]
      >(`
        SELECT economy_quality, economy_delta, economy_balance_after,
               catgirl_mode, catgirl_messages_left
        FROM jobs
        WHERE id = ?
      `)
      .get(jobId);
    if (!row || row.economy_balance_after === null) {
      return null;
    }
    return {
      assessmentReason: this.connection
        .query<{ reason: string }, [number]>(`
        SELECT json_extract(metadata_json, '$.reason') AS reason FROM leylobucks_transactions
        WHERE job_id = ? AND reason = 'contextual_assessment' ORDER BY id DESC LIMIT 1
      `)
        .get(jobId)?.reason,
      qualityScore: row.economy_quality ?? 50,
      delta: row.economy_delta,
      balance: row.economy_balance_after,
      catgirlMode: row.catgirl_mode === 1,
      catgirlMessagesLeft: row.catgirl_messages_left,
    };
  }

  settleLeylobucksAssessment(
    jobId: number,
    assessment: { qualityScore: number; reason: string },
  ): void {
    if (
      !Number.isInteger(assessment.qualityScore) ||
      assessment.qualityScore < 0 ||
      assessment.qualityScore > 100 ||
      typeof assessment.reason !== "string" ||
      !assessment.reason.trim() ||
      assessment.reason.length > 500
    ) {
      throw new Error("Invalid contextual assessment");
    }
    const transaction = this.connection.transaction(() => {
      const job = this.connection
        .query<
          {
            user_id: number | null;
            economy_quality: number | null;
            economy_balance_after: number | null;
          },
          [number]
        >(
          "SELECT user_id, economy_quality, economy_balance_after FROM jobs WHERE id = ? AND state = 'running'",
        )
        .get(jobId);
      // Old jobs are already assessed. Retries must never charge twice.
      if (
        !job ||
        job.user_id === null ||
        job.economy_balance_after === null ||
        job.economy_quality !== null
      )
        return;
      const delta = Math.max(-100, Math.min(100, (assessment.qualityScore - 50) * 2));
      const balance = this.ensureLeylobucksAccount(job.user_id).balance + delta;
      if (!Number.isSafeInteger(balance))
        throw new Error("Loylebucks balance would exceed the safe integer range");
      const now = Date.now();
      this.connection
        .query("UPDATE leylobucks_accounts SET balance = ?, updated_at = ? WHERE user_id = ?")
        .run(balance, now, job.user_id);
      this.connection
        .query(
          "UPDATE jobs SET economy_quality = ?, economy_delta = ?, economy_balance_after = ? WHERE id = ?",
        )
        .run(assessment.qualityScore, delta, balance, jobId);
      this.connection
        .query(`INSERT INTO leylobucks_transactions
        (user_id, delta, balance_after, reason, job_id, metadata_json, created_at)
        VALUES (?, ?, ?, 'contextual_assessment', ?, ?, ?)`)
        .run(
          job.user_id,
          delta,
          balance,
          jobId,
          JSON.stringify({ ...assessment, evaluator: "contextual-v1" }),
          now,
        );
    });
    transaction.immediate();
  }
}
