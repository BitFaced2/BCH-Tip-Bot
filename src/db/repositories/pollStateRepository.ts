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

  getWithAge(key: string): { value: string; updatedAt: string } | undefined {
    const row = this.db
      .prepare("SELECT value, updated_at FROM poll_state WHERE key = ?")
      .get(key) as PollState | undefined;
    if (!row) return undefined;
    return { value: row.value, updatedAt: row.updated_at };
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

  delete(key: string): void {
    this.db.prepare("DELETE FROM poll_state WHERE key = ?").run(key);
  }

  /**
   * Backdate a row's updated_at without touching its value — used to retire a
   * since_id that X has rejected as too old while keeping the id itself as a
   * local high-water mark. Deleting the row instead would lose that mark and
   * let the next poll replay every mention X still returns.
   */
  expire(key: string, daysAgo: number): void {
    this.db
      .prepare(
        `UPDATE poll_state SET updated_at = datetime('now', ?) WHERE key = ?`
      )
      .run(`-${daysAgo} days`, key);
  }
}
