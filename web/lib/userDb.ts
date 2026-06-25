import Database from "better-sqlite3";
import { config } from "./config.js";

export interface WebUser {
  id: number;
  twitter_user_id: string;
  twitter_username: string | null;
  derivation_index: number;
  deposit_address: string;
  balance_satoshis: number;
}

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(config.dbPath, { fileMustExist: true });
  _db.pragma("journal_mode = WAL");
  return _db;
}

/**
 * Look up the signed-in X user's row. If they don't have one yet but a
 * placeholder exists from a tip they received before signing in (twitter_user_id
 * like 'pending_<username>'), atomically claim it: rebind it to their real X
 * user id and refresh the username. Returns null if no row matches either way.
 */
export function findOrClaimUser(
  twitterUserId: string,
  username: string
): WebUser | null {
  const direct = db()
    .prepare(
      `SELECT id, twitter_user_id, twitter_username, derivation_index,
              deposit_address, balance_satoshis
         FROM users WHERE twitter_user_id = ?`
    )
    .get(twitterUserId) as WebUser | undefined;
  if (direct) return direct;

  const pendingKey = `pending_${username.toLowerCase()}`;
  // Use a transaction so the SELECT and UPDATE see the same snapshot — and so
  // two concurrent sign-ins of the same account can't both win the claim.
  const claim = db().transaction((): WebUser | null => {
    const row = db()
      .prepare(
        `SELECT id, twitter_user_id, twitter_username, derivation_index,
                deposit_address, balance_satoshis
           FROM users WHERE LOWER(twitter_user_id) = ?`
      )
      .get(pendingKey) as WebUser | undefined;
    if (!row) return null;
    db()
      .prepare(
        `UPDATE users
            SET twitter_user_id = ?, twitter_username = ?, updated_at = datetime('now')
          WHERE id = ?`
      )
      .run(twitterUserId, username, row.id);
    row.twitter_user_id = twitterUserId;
    row.twitter_username = username;
    return row;
  });
  return claim.immediate();
}

export interface InFlightWithdrawal {
  id: number;
  amount_satoshis: number;
  address: string | null;
  status: "queued" | "pending";
  created_at: string;
}

export function findInFlightWithdrawal(userId: number): InFlightWithdrawal | null {
  const row = db()
    .prepare(
      `SELECT id, amount_satoshis, address, status, created_at
         FROM transactions
        WHERE user_id = ? AND type = 'withdrawal' AND status IN ('queued', 'pending')
        ORDER BY id DESC LIMIT 1`
    )
    .get(userId) as InFlightWithdrawal | undefined;
  return row ?? null;
}

export type QueueResult =
  | { ok: true; id: number }
  | { ok: false; error: string };

/**
 * Validate the user has enough balance and no in-flight withdrawal, then
 * insert a queued withdrawal row. All checks and the insert run inside a
 * single IMMEDIATE transaction so two parallel submissions can't both win.
 *
 * The bot's WithdrawalProcessor picks queued rows up within ~10 seconds,
 * debits the balance atomically, and broadcasts.
 */
export function queueWithdrawal(
  userId: number,
  amountSatoshis: number,
  feeSatoshis: number,
  normalizedAddress: string
): QueueResult {
  const totalDebit = amountSatoshis + feeSatoshis;
  let result: QueueResult = { ok: false, error: "unknown" };

  const txn = db().transaction(() => {
    const existing = db()
      .prepare(
        `SELECT id FROM transactions
          WHERE user_id = ? AND type = 'withdrawal' AND status IN ('queued', 'pending')`
      )
      .get(userId) as { id: number } | undefined;
    if (existing) {
      result = {
        ok: false,
        error: "You already have a withdrawal in progress. Wait for it to settle before queuing another.",
      };
      return;
    }
    const user = db()
      .prepare("SELECT balance_satoshis FROM users WHERE id = ?")
      .get(userId) as { balance_satoshis: number } | undefined;
    if (!user) {
      result = { ok: false, error: "Account not found." };
      return;
    }
    if (user.balance_satoshis < totalDebit) {
      result = {
        ok: false,
        error: `Insufficient balance. You have ${user.balance_satoshis.toLocaleString()} sats; need ${totalDebit.toLocaleString()} (amount + ${feeSatoshis} sat fee).`,
      };
      return;
    }
    const insert = db()
      .prepare(
        `INSERT INTO transactions (user_id, type, amount_satoshis, address, txid, status)
         VALUES (?, 'withdrawal', ?, ?, NULL, 'queued')`
      )
      .run(userId, amountSatoshis, normalizedAddress);
    result = { ok: true, id: insert.lastInsertRowid as number };
  });
  txn.immediate();
  return result;
}

export interface HistoryRow {
  id: number;
  type: "deposit" | "withdrawal" | "tip_received" | "tip_sent";
  amount_satoshis: number;
  counterparty: string | null; // address for tx, @username for tips
  txid: string | null;
  status: string;
  created_at: string;
}

/**
 * Recent activity for the dashboard. Unions on-chain transactions
 * (deposits + withdrawals) and tips (received + sent + returned) into one
 * chronological list. Tip rows show the counterparty handle; transaction
 * rows show the on-chain address.
 */
export function getRecentActivity(userId: number, limit: number): HistoryRow[] {
  return db()
    .prepare(
      `SELECT id, type, amount_satoshis, address AS counterparty, txid,
              status, created_at
         FROM transactions
        WHERE user_id = ? AND type IN ('deposit', 'withdrawal')
       UNION ALL
       SELECT t.id, 'tip_received' AS type, t.amount_satoshis,
              u.twitter_username AS counterparty,
              NULL AS txid, t.status, t.created_at
         FROM tips t JOIN users u ON u.id = t.from_user_id
        WHERE t.to_user_id = ?
       UNION ALL
       SELECT t.id, 'tip_sent' AS type, t.amount_satoshis,
              u.twitter_username AS counterparty,
              NULL AS txid, t.status, t.created_at
         FROM tips t JOIN users u ON u.id = t.to_user_id
        WHERE t.from_user_id = ?
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .all(userId, userId, userId, limit) as HistoryRow[];
}
