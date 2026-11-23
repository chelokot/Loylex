import { Database } from "bun:sqlite";

export abstract class DatabaseConnection {
  readonly connection: Database;

  constructor(path: string) {
    this.connection = new Database(path, { create: true, strict: true });
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  close(): void {
    this.connection.close();
  }

  nextUpdateOffset(): number {
    const row = this.connection
      .query<{ update_id: number | null }, []>(`
        SELECT max(update_id) AS update_id
        FROM (
          SELECT max(update_id) AS update_id FROM updates
          UNION ALL
          SELECT update_id FROM update_cursor WHERE id = 1
        )
      `)
      .get();
    return (row?.update_id ?? -1) + 1;
  }

  protected abstract migrate(): void;
}
