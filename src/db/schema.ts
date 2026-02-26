import type Database from "better-sqlite3";

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      twitter_user_id   TEXT    NOT NULL UNIQUE,
      twitter_username  TEXT,
      derivation_index  INTEGER NOT NULL UNIQUE,
      deposit_address   TEXT    NOT NULL UNIQUE,
      balance_satoshis  INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_users_twitter_user_id ON users(twitter_user_id);
    CREATE INDEX IF NOT EXISTS idx_users_deposit_address ON users(deposit_address);

    CREATE TABLE IF NOT EXISTS transactions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           INTEGER NOT NULL REFERENCES users(id),
      type              TEXT    NOT NULL CHECK(type IN ('deposit', 'withdrawal')),
      amount_satoshis   INTEGER NOT NULL,
      txid              TEXT,
      address           TEXT,
      confirmations     INTEGER NOT NULL DEFAULT 0,
      status            TEXT    NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('pending', 'confirming', 'confirmed', 'failed')),
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_txid ON transactions(txid);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);

    CREATE TABLE IF NOT EXISTS tips (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user_id      INTEGER NOT NULL REFERENCES users(id),
      to_user_id        INTEGER NOT NULL REFERENCES users(id),
      amount_satoshis   INTEGER NOT NULL,
      fee_satoshis      INTEGER NOT NULL DEFAULT 0,
      tweet_id          TEXT,
      status            TEXT    NOT NULL DEFAULT 'completed'
                                CHECK(status IN ('completed', 'failed')),
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tips_from_user_id ON tips(from_user_id);
    CREATE INDEX IF NOT EXISTS idx_tips_to_user_id ON tips(to_user_id);
    CREATE INDEX IF NOT EXISTS idx_tips_tweet_id ON tips(tweet_id);

    CREATE TABLE IF NOT EXISTS poll_state (
      key               TEXT PRIMARY KEY,
      value             TEXT NOT NULL,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key               TEXT PRIMARY KEY,
      value             TEXT NOT NULL
    );

    INSERT OR IGNORE INTO app_state (key, value) VALUES ('next_derivation_index', '1');
  `);
}
