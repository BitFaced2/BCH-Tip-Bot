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
                                CHECK(status IN ('queued', 'pending', 'confirming', 'confirmed', 'failed')),
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
                                CHECK(status IN ('completed', 'failed', 'returned')),
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

  migrateAddQueuedStatus(db);
  migrateAddReturnedTipStatus(db);
  migrateAddHasClaimed(db);
}

/**
 * Adds users.has_claimed — the signal for "this person has actively engaged
 * with their wallet" (dashboard sign-in or a successful sent tip). Replaces
 * the pending_ twitter_user_id prefix as the welcome-message and
 * return-to-sender eligibility check: the prefix misses accounts created as
 * a side effect of a failed tip *attempt* (ensureUser runs on senders before
 * the balance check), which have a real twitter_user_id but were never
 * claimed by their owner.
 *
 * One-time backfill grandfathers every real-ID account with any activity at
 * all (balance, tips either direction, or on-chain transactions) as claimed
 * — the population mixes dashboard sign-ins and DM-era users we can't
 * distinguish from tip-attempt accounts, and retroactively returning funds
 * from someone who signed in would break the "signed in means yours forever"
 * promise. Dormant zero-activity accounts start unclaimed: nothing to claw
 * back, and any real owner's next dashboard visit flips the flag.
 */
function migrateAddHasClaimed(db: Database.Database): void {
  const columns = db.pragma("table_info(users)") as { name: string }[];
  if (columns.some((c) => c.name === "has_claimed")) return;

  const txn = db.transaction(() => {
    db.exec(`
      ALTER TABLE users ADD COLUMN has_claimed INTEGER NOT NULL DEFAULT 0;
      UPDATE users SET has_claimed = 1
       WHERE twitter_user_id NOT LIKE 'pending_%'
         AND (
           balance_satoshis > 0
           OR EXISTS (SELECT 1 FROM tips t WHERE t.from_user_id = users.id)
           OR EXISTS (SELECT 1 FROM tips t WHERE t.to_user_id = users.id)
           OR EXISTS (SELECT 1 FROM transactions x WHERE x.user_id = users.id)
         );
    `);
  });
  txn.immediate();
}

/**
 * SQLite CHECK constraints can't be ALTER'd in place. If the existing
 * transactions table was created before 'queued' was added to the status
 * domain, recreate the table with the new constraint and copy the rows
 * across. Idempotent — does nothing on tables already containing 'queued'.
 */
/**
 * Adds 'returned' to the tips.status CHECK domain for the return-to-sender
 * feature. SQLite can't alter a CHECK in place — recreate and copy.
 *
 * Follows SQLite's documented "12-step table modification" recipe:
 * foreign_keys must be OFF during the DROP+RENAME because tips has two
 * REFERENCES users(id) constraints (with foreign_keys=ON the FK metadata
 * rebind during ALTER TABLE RENAME trips the enforcement check). The
 * pragma is a no-op inside a transaction, so it has to be set first.
 */
function migrateAddReturnedTipStatus(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tips'")
    .get() as { sql: string } | undefined;
  if (!row) return;
  if (row.sql.includes("'returned'")) return;

  db.pragma("foreign_keys = OFF");
  try {
    const txn = db.transaction(() => {
      db.exec(`
        CREATE TABLE tips_new (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          from_user_id      INTEGER NOT NULL REFERENCES users(id),
          to_user_id        INTEGER NOT NULL REFERENCES users(id),
          amount_satoshis   INTEGER NOT NULL,
          fee_satoshis      INTEGER NOT NULL DEFAULT 0,
          tweet_id          TEXT,
          status            TEXT    NOT NULL DEFAULT 'completed'
                                    CHECK(status IN ('completed', 'failed', 'returned')),
          created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO tips_new
          SELECT id, from_user_id, to_user_id, amount_satoshis, fee_satoshis,
                 tweet_id, status, created_at
            FROM tips;
        DROP TABLE tips;
        ALTER TABLE tips_new RENAME TO tips;
        CREATE INDEX IF NOT EXISTS idx_tips_from_user_id ON tips(from_user_id);
        CREATE INDEX IF NOT EXISTS idx_tips_to_user_id ON tips(to_user_id);
        CREATE INDEX IF NOT EXISTS idx_tips_tweet_id ON tips(tweet_id);
      `);
    });
    txn.immediate();

    // Post-migration sanity check before re-enabling enforcement.
    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(
        "foreign_key_check found violations after tips migration: " +
          JSON.stringify(violations)
      );
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function migrateAddQueuedStatus(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'")
    .get() as { sql: string } | undefined;
  if (!row) return;
  if (row.sql.includes("'queued'")) return;

  const txn = db.transaction(() => {
    db.exec(`
      CREATE TABLE transactions_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           INTEGER NOT NULL REFERENCES users(id),
        type              TEXT    NOT NULL CHECK(type IN ('deposit', 'withdrawal')),
        amount_satoshis   INTEGER NOT NULL,
        txid              TEXT,
        address           TEXT,
        confirmations     INTEGER NOT NULL DEFAULT 0,
        status            TEXT    NOT NULL DEFAULT 'pending'
                                  CHECK(status IN ('queued', 'pending', 'confirming', 'confirmed', 'failed')),
        created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO transactions_new
        SELECT id, user_id, type, amount_satoshis, txid, address, confirmations,
               status, created_at, updated_at
          FROM transactions;
      DROP TABLE transactions;
      ALTER TABLE transactions_new RENAME TO transactions;
      CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_txid ON transactions(txid);
      CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    `);
  });
  txn.immediate();
}
