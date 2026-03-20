import type Database from "better-sqlite3";
import type { Tip } from "../../types/index.js";

export class TipRepository {
  constructor(private db: Database.Database) {}

  findById(id: number): Tip | undefined {
    return this.db
      .prepare("SELECT * FROM tips WHERE id = ?")
      .get(id) as Tip | undefined;
  }

  findByTweetId(tweetId: string): Tip | undefined {
    return this.db
      .prepare("SELECT * FROM tips WHERE tweet_id = ?")
      .get(tweetId) as Tip | undefined;
  }

  findByTweetIdAndRecipient(tweetId: string, toUserId: number): Tip | undefined {
    return this.db
      .prepare("SELECT * FROM tips WHERE tweet_id = ? AND to_user_id = ?")
      .get(tweetId, toUserId) as Tip | undefined;
  }

  create(
    fromUserId: number,
    toUserId: number,
    amountSatoshis: number,
    feeSatoshis: number,
    tweetId: string | null
  ): Tip {
    const result = this.db
      .prepare(
        `INSERT INTO tips (from_user_id, to_user_id, amount_satoshis, fee_satoshis, tweet_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(fromUserId, toUserId, amountSatoshis, feeSatoshis, tweetId);

    return this.findById(result.lastInsertRowid as number)!;
  }

  getTotalFees(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(fee_satoshis), 0) as total FROM tips WHERE status = 'completed'")
      .get() as { total: number };
    return row.total;
  }

  getTipsSentByUser(userId: number): Tip[] {
    return this.db
      .prepare("SELECT * FROM tips WHERE from_user_id = ? ORDER BY created_at DESC")
      .all(userId) as Tip[];
  }

  getTipsReceivedByUser(userId: number): Tip[] {
    return this.db
      .prepare("SELECT * FROM tips WHERE to_user_id = ? ORDER BY created_at DESC")
      .all(userId) as Tip[];
  }
}
