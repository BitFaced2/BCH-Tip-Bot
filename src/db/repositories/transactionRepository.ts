import type Database from "better-sqlite3";
import type { Transaction } from "../../types/index.js";

export class TransactionRepository {
  constructor(private db: Database.Database) {}

  findById(id: number): Transaction | undefined {
    return this.db
      .prepare("SELECT * FROM transactions WHERE id = ?")
      .get(id) as Transaction | undefined;
  }

  findByTxid(txid: string): Transaction | undefined {
    return this.db
      .prepare("SELECT * FROM transactions WHERE txid = ?")
      .get(txid) as Transaction | undefined;
  }

  findPendingDeposits(): Transaction[] {
    return this.db
      .prepare(
        "SELECT * FROM transactions WHERE type = 'deposit' AND status IN ('pending', 'confirming')"
      )
      .all() as Transaction[];
  }

  create(
    userId: number,
    type: "deposit" | "withdrawal",
    amountSatoshis: number,
    address: string | null,
    txid: string | null
  ): Transaction {
    const result = this.db
      .prepare(
        `INSERT INTO transactions (user_id, type, amount_satoshis, address, txid)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(userId, type, amountSatoshis, address, txid);

    return this.findById(result.lastInsertRowid as number)!;
  }

  updateStatus(id: number, status: Transaction["status"]): void {
    this.db
      .prepare(
        "UPDATE transactions SET status = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(status, id);
  }

  // Atomically mark a deposit confirmed only if it isn't already. Returns true
  // when the row was actually changed, so callers can gate one-shot side effects
  // (e.g. crediting a balance) on the winning update.
  tryMarkConfirmed(id: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE transactions SET status = 'confirmed', updated_at = datetime('now') WHERE id = ? AND status != 'confirmed'"
      )
      .run(id);
    return result.changes > 0;
  }

  updateConfirmations(id: number, confirmations: number): void {
    this.db
      .prepare(
        "UPDATE transactions SET confirmations = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(confirmations, id);
  }

  updateTxid(id: number, txid: string): void {
    this.db
      .prepare(
        "UPDATE transactions SET txid = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(txid, id);
  }

  getByUserId(userId: number): Transaction[] {
    return this.db
      .prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as Transaction[];
  }
}
