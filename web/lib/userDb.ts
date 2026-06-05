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
