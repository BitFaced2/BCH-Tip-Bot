import type Database from "better-sqlite3";
import { UserRepository } from "../db/repositories/userRepository.js";
import { BalanceService } from "../services/balanceService.js";
import type { Tip, User } from "../types/index.js";
import pino from "pino";

const logger = pino({ name: "tip-return-processor" });

/**
 * Tips delivered to recipients who never signed in are refunded to the sender
 * after the unclaimed window elapses.
 *
 * "Unclaimed" = recipient's has_claimed flag is still 0 — they have neither
 * signed in on the dashboard nor sent a tip of their own. (Formerly keyed on
 * the pending_ twitter_user_id prefix, which missed accounts created as a
 * side effect of a failed tip attempt.) Window default = 7 days.
 *
 * Fee accounting is model-aware. Tips processed before commit 2a55d8c used
 * the "old" model where the recipient absorbed the fee (got amount - fee)
 * and the sender paid exactly amount. Tips after that used the current
 * "new" model where the sender pays amount + fee on top and the recipient
 * receives the full amount. Refunds reverse whichever model applied, so
 * post-refund balances exactly match the pre-tip state.
 *
 * The commit timestamp is hardcoded because it's a one-time historical
 * boundary. New tips don't need a date check — they're all new-model.
 */
const OLD_MODEL_CUTOFF_UTC = "2026-03-20 19:29:04";

export class TipReturnProcessor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private userRepo: UserRepository;
  private balanceService: BalanceService;
  private feeUserId: number | null = null;

  constructor(
    private db: Database.Database,
    private feeAddress: string,
    private unclaimedWindowDays: number,
    private pollIntervalMs: number
  ) {
    this.userRepo = new UserRepository(db);
    this.balanceService = new BalanceService(db);
  }

  start(): void {
    if (this.feeAddress) {
      const feeUser = this.userRepo.findByDepositAddress(this.feeAddress);
      this.feeUserId = feeUser?.id ?? null;
      if (!this.feeUserId) {
        logger.warn("Fee address configured but no fee_collector user — fee debits will be skipped on returns");
      }
    }
    logger.info(
      { windowDays: this.unclaimedWindowDays, intervalMs: this.pollIntervalMs },
      "Starting tip return processor"
    );
    this.tick().catch((err) => logger.error({ err }, "Initial tip-return tick failed"));
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("Tip return processor stopped");
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const eligible = this.findEligibleTips();
      if (eligible.length === 0) return;
      logger.info({ count: eligible.length }, "Processing tip returns");
      let returned = 0;
      for (const tip of eligible) {
        if (this.returnOne(tip.id)) returned++;
      }
      logger.info({ returned, attempted: eligible.length }, "Tip return pass complete");
    } catch (err) {
      logger.error({ err }, "Error in tip-return tick");
    } finally {
      this.running = false;
    }
  }

  private findEligibleTips(): Pick<Tip, "id">[] {
    return this.db
      .prepare(
        `SELECT t.id FROM tips t
           JOIN users u ON u.id = t.to_user_id
          WHERE t.status = 'completed'
            AND t.created_at < datetime('now', ?)
            AND u.has_claimed = 0
          ORDER BY t.id ASC`
      )
      .all(`-${this.unclaimedWindowDays} days`) as Pick<Tip, "id">[];
  }

  /**
   * Atomic refund. Returns true if the tip was successfully returned, false
   * if a race or insufficient-balance check aborted it.
   */
  private returnOne(tipId: number): boolean {
    const txn = this.db.transaction((): boolean => {
      // Re-read tip inside the txn so we see its current state under the
      // IMMEDIATE write lock.
      const tip = this.db
        .prepare("SELECT * FROM tips WHERE id = ?")
        .get(tipId) as Tip | undefined;
      if (!tip || tip.status !== "completed") return false;

      const recipient = this.db
        .prepare("SELECT * FROM users WHERE id = ?")
        .get(tip.to_user_id) as User | undefined;
      if (!recipient) return false;
      if (recipient.has_claimed) {
        // Recipient claimed their wallet between findEligible and now. Don't refund.
        return false;
      }

      const isOldModel = tip.created_at < OLD_MODEL_CUTOFF_UTC;
      const recipientDebit = isOldModel
        ? tip.amount_satoshis - tip.fee_satoshis
        : tip.amount_satoshis;
      const senderCredit = isOldModel
        ? tip.amount_satoshis
        : tip.amount_satoshis + tip.fee_satoshis;
      const feeDebit = tip.fee_satoshis;

      if (recipientDebit > 0) {
        if (!this.balanceService.debit(tip.to_user_id, recipientDebit)) {
          // Defense-in-depth — pre-flight audit ruled this out, but if state
          // has drifted we abort cleanly instead of overdrafting.
          throw new Error(
            `Recipient ${tip.to_user_id} balance < refund debit ${recipientDebit} for tip ${tipId}`
          );
        }
      }

      if (feeDebit > 0 && this.feeUserId !== null) {
        if (!this.balanceService.debit(this.feeUserId, feeDebit)) {
          throw new Error(
            `fee_collector balance < refund debit ${feeDebit} for tip ${tipId}`
          );
        }
      }

      if (senderCredit > 0) {
        this.balanceService.credit(tip.from_user_id, senderCredit);
      }

      this.db
        .prepare("UPDATE tips SET status = 'returned' WHERE id = ?")
        .run(tipId);

      logger.info(
        {
          tipId,
          fromUserId: tip.from_user_id,
          toUserId: tip.to_user_id,
          model: isOldModel ? "old" : "new",
          recipientDebit,
          senderCredit,
          feeDebit,
        },
        "Tip returned"
      );
      return true;
    });
    try {
      return txn.immediate();
    } catch (err) {
      logger.error({ err, tipId }, "Tip refund aborted");
      return false;
    }
  }
}
