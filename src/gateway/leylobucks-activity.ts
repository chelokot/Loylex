import type { Database } from "bun:sqlite";

export const leylobucksIdleMs = 48 * 60 * 60 * 1000;

// Separate from the explicit enabled preference: waking an idle account must never
// undo a manual /bucks off. Ordinary earnings and response footers are not activity.
export class LeylobucksActivity {
  constructor(private readonly connection: Database) {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS leylobucks_activity (
        user_id INTEGER PRIMARY KEY,
        last_interaction_at INTEGER NOT NULL,
        auto_hidden INTEGER NOT NULL DEFAULT 0 CHECK (auto_hidden IN (0, 1))
      );
      INSERT OR IGNORE INTO leylobucks_activity (user_id, last_interaction_at)
        SELECT user_id, updated_at FROM leylobucks_accounts;
      CREATE TRIGGER IF NOT EXISTS leylobucks_manual_mode_activity
      AFTER UPDATE OF enabled ON leylobucks_accounts
      BEGIN
        INSERT INTO leylobucks_activity (user_id, last_interaction_at, auto_hidden)
        VALUES (NEW.user_id, NEW.updated_at, 0)
        ON CONFLICT(user_id) DO UPDATE SET
          last_interaction_at = excluded.last_interaction_at, auto_hidden = 0;
      END;
    `);
  }

  isVisible(userId: number, now = Date.now()): boolean {
    this.connection
      .query(
        "INSERT OR IGNORE INTO leylobucks_activity (user_id, last_interaction_at) VALUES (?, ?)",
      )
      .run(userId, now);
    this.connection
      .query(`UPDATE leylobucks_activity SET auto_hidden = 1
        WHERE user_id = ? AND last_interaction_at <= ?`)
      .run(userId, now - leylobucksIdleMs);
    return (
      this.connection
        .query<{ auto_hidden: number }, [number]>(
          "SELECT auto_hidden FROM leylobucks_activity WHERE user_id = ?",
        )
        .get(userId)?.auto_hidden === 0
    );
  }

  interact(userId: number, now = Date.now()): void {
    this.connection
      .query(`INSERT INTO leylobucks_activity (user_id, last_interaction_at, auto_hidden)
        VALUES (?, ?, 0) ON CONFLICT(user_id) DO UPDATE SET
        last_interaction_at = excluded.last_interaction_at, auto_hidden = 0`)
      .run(userId, now);
  }
}
