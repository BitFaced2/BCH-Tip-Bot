import type Database from "better-sqlite3";
import type { User } from "../../types/index.js";

export class UserRepository {
  constructor(private db: Database.Database) {}

  findByTwitterId(twitterUserId: string): User | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE twitter_user_id = ?")
      .get(twitterUserId) as User | undefined;
  }

  findByUsername(username: string): User | undefined {
    return this.db
      .prepare(
        "SELECT * FROM users WHERE LOWER(twitter_username) = LOWER(?)"
      )
      .get(username) as User | undefined;
  }

  findByDepositAddress(address: string): User | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE deposit_address = ?")
      .get(address) as User | undefined;
  }

  findById(id: number): User | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(id) as User | undefined;
  }

  create(
    twitterUserId: string,
    twitterUsername: string,
    derivationIndex: number,
    depositAddress: string
  ): User {
    const result = this.db
      .prepare(
        `INSERT INTO users (twitter_user_id, twitter_username, derivation_index, deposit_address)
         VALUES (?, ?, ?, ?)`
      )
      .run(twitterUserId, twitterUsername, derivationIndex, depositAddress);

    return this.findById(result.lastInsertRowid as number)!;
  }

  updateBalance(userId: number, newBalanceSatoshis: number): void {
    this.db
      .prepare(
        "UPDATE users SET balance_satoshis = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(newBalanceSatoshis, userId);
  }

  updateUsername(userId: number, username: string): void {
    this.db
      .prepare(
        "UPDATE users SET twitter_username = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(username, userId);
  }

  updateTwitterId(userId: number, twitterUserId: string): void {
    this.db
      .prepare(
        "UPDATE users SET twitter_user_id = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(twitterUserId, userId);
  }

  getNextDerivationIndex(): number {
    const row = this.db
      .prepare("SELECT value FROM app_state WHERE key = 'next_derivation_index'")
      .get() as { value: string };

    const index = parseInt(row.value, 10);

    this.db
      .prepare("UPDATE app_state SET value = ? WHERE key = 'next_derivation_index'")
      .run(String(index + 1));

    return index;
  }

  getAllWithBalance(): User[] {
    return this.db
      .prepare("SELECT * FROM users WHERE balance_satoshis > 0")
      .all() as User[];
  }

  getAll(): User[] {
    return this.db.prepare("SELECT * FROM users").all() as User[];
  }
}
