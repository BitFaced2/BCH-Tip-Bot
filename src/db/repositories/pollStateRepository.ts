import type Database from "better-sqlite3";
import type { PollState } from "../../types/index.js";

export class PollStateRepository {
  constructor(private db: Database.Database) {}

  get(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM poll_state WHERE key = ?")
      .get(key) as PollState | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO poll_state (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`
      )
      .run(key, value, value);
  }
}
