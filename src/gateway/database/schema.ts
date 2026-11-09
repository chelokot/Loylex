import { DatabaseMessageSchema } from "./message-schema.ts";

export abstract class DatabaseSchema extends DatabaseMessageSchema {
  protected migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS updates (
        update_id INTEGER PRIMARY KEY,
        event_type TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS update_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        update_id INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id INTEGER NOT NULL UNIQUE,
        chat_id INTEGER NOT NULL,
        chat_type TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        message_thread_id INTEGER,
        user_id INTEGER,
        prompt TEXT NOT NULL,
        resume_thread_id TEXT,
        context_mode TEXT NOT NULL DEFAULT 'full',
        attachments_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        claimed_at INTEGER,
        worker_id TEXT,
        lease_expires_at INTEGER,
        worker_generation INTEGER NOT NULL DEFAULT 1,
        completed_at INTEGER,
        codex_thread_id TEXT,
        thinking_message_id INTEGER,
        status_log TEXT NOT NULL DEFAULT '',
        error TEXT,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_write_input_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_output_tokens INTEGER,
        total_tokens INTEGER,
        answer TEXT,
        feedback_for_job_id INTEGER,
        economy_quality INTEGER,
        economy_delta INTEGER NOT NULL DEFAULT 0,
        economy_balance_after INTEGER,
        catgirl_mode INTEGER NOT NULL DEFAULT 0,
        catgirl_messages_left INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbound_messages (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        job_id INTEGER,
        codex_thread_id TEXT,
        sent_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, message_id),
        FOREIGN KEY (job_id) REFERENCES jobs(id)
      );

      CREATE INDEX IF NOT EXISTS jobs_state_created_idx ON jobs(state, created_at);
      CREATE INDEX IF NOT EXISTS jobs_resume_thread_idx
        ON jobs(state, resume_thread_id, created_at, id);
      CREATE INDEX IF NOT EXISTS jobs_codex_thread_idx
        ON jobs(chat_id, codex_thread_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS jobs_usage_user_idx ON jobs(user_id, created_at);
      CREATE INDEX IF NOT EXISTS jobs_usage_forum_idx
        ON jobs(chat_id, message_thread_id, created_at);
      CREATE INDEX IF NOT EXISTS outbound_thread_idx ON outbound_messages(codex_thread_id);

      CREATE TABLE IF NOT EXISTS job_steers (
        id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        message_id INTEGER NOT NULL,
        reply_message_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        UNIQUE(job_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS job_steers_pending_idx ON job_steers(job_id, state, id);

      CREATE TABLE IF NOT EXISTS workers (
        worker_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'draining', 'stopped')),
        registered_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        drain_requested_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS worker_runtime (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active_worker_id TEXT,
        active_generation INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS leylobucks_accounts (
        user_id INTEGER PRIMARY KEY,
        balance INTEGER NOT NULL DEFAULT 0,
        catgirl_messages INTEGER NOT NULL DEFAULT 0,
        next_quiz_size INTEGER NOT NULL DEFAULT 5 CHECK (next_quiz_size >= 5),
        quiz_attempt INTEGER NOT NULL DEFAULT 0 CHECK (quiz_attempt >= 0),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS leylobucks_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        delta INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        reason TEXT NOT NULL,
        update_id INTEGER,
        job_id INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, update_id)
      );

      CREATE TABLE IF NOT EXISTS leylobucks_quiz_sessions (
        user_id INTEGER PRIMARY KEY,
        question_count INTEGER NOT NULL CHECK (question_count >= 5),
        questions_json TEXT NOT NULL,
        answers_json TEXT NOT NULL DEFAULT '[]',
        question_index INTEGER NOT NULL DEFAULT 0,
        correct_count INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS leylobucks_transactions_user_idx
        ON leylobucks_transactions(user_id, created_at DESC, id DESC);
    `);
    this.ensureLeylobucksQuizSessionColumn("answers_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureLeylobucksAccountColumn(
      "enabled",
      "INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))",
    );
    this.ensureJobColumn("worker_id", "TEXT");
    this.ensureJobColumn("lease_expires_at", "INTEGER");
    this.ensureJobColumn("worker_generation", "INTEGER NOT NULL DEFAULT 1");
    this.ensureJobColumn("context_mode", "TEXT NOT NULL DEFAULT 'full'");
    this.ensureJobColumn("input_tokens", "INTEGER");
    this.ensureJobColumn("cached_input_tokens", "INTEGER");
    this.ensureJobColumn("cache_write_input_tokens", "INTEGER");
    this.ensureJobColumn("output_tokens", "INTEGER");
    this.ensureJobColumn("reasoning_output_tokens", "INTEGER");
    this.ensureJobColumn("total_tokens", "INTEGER");
    this.ensureJobColumn("answer", "TEXT");
    this.ensureJobColumn("feedback_for_job_id", "INTEGER");
    this.ensureJobColumn("economy_quality", "INTEGER");
    this.ensureJobColumn("economy_delta", "INTEGER NOT NULL DEFAULT 0");
    this.ensureJobColumn("economy_balance_after", "INTEGER");
    this.ensureJobColumn("catgirl_mode", "INTEGER NOT NULL DEFAULT 0");
    this.ensureJobColumn("catgirl_messages_left", "INTEGER NOT NULL DEFAULT 0");
    this.connection.exec(
      "CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs(state, lease_expires_at); CREATE INDEX IF NOT EXISTS jobs_worker_generation_idx ON jobs(worker_generation, state, created_at, id); CREATE UNIQUE INDEX IF NOT EXISTS jobs_feedback_source_idx ON jobs(feedback_for_job_id) WHERE feedback_for_job_id IS NOT NULL",
    );
    this.connection
      .query(
        "INSERT OR IGNORE INTO worker_runtime (id, active_worker_id, active_generation, updated_at) VALUES (1, NULL, 1, ?)",
      )
      .run(Date.now());
    this.migrateNormalizedSchema();
  }

  protected ensureJobColumn(
    name:
      | "worker_id"
      | "lease_expires_at"
      | "worker_generation"
      | "context_mode"
      | "input_tokens"
      | "cached_input_tokens"
      | "cache_write_input_tokens"
      | "output_tokens"
      | "reasoning_output_tokens"
      | "total_tokens"
      | "answer"
      | "feedback_for_job_id"
      | "economy_quality"
      | "economy_delta"
      | "economy_balance_after"
      | "catgirl_mode"
      | "catgirl_messages_left",
    definition: string,
  ): void {
    const columns = this.connection.query<{ name: string }, []>("PRAGMA table_info(jobs)").all();
    if (!columns.some((column) => column.name === name)) {
      this.connection.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
    }
  }

  protected ensureLeylobucksQuizSessionColumn(name: "answers_json", definition: string): void {
    const columns = this.connection
      .query<{ name: string }, []>("PRAGMA table_info(leylobucks_quiz_sessions)")
      .all();
    if (!columns.some((column) => column.name === name)) {
      this.connection.exec(`ALTER TABLE leylobucks_quiz_sessions ADD COLUMN ${name} ${definition}`);
    }
  }

  protected ensureLeylobucksAccountColumn(name: "enabled", definition: string): void {
    const columns = this.connection
      .query<{ name: string }, []>("PRAGMA table_info(leylobucks_accounts)")
      .all();
    if (!columns.some((column) => column.name === name)) {
      this.connection.exec(`ALTER TABLE leylobucks_accounts ADD COLUMN ${name} ${definition}`);
    }
  }
}
