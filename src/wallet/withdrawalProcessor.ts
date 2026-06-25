import type Database from "better-sqlite3";
import { UserRepository } from "../db/repositories/userRepository.js";
import { TransactionRepository } from "../db/repositories/transactionRepository.js";
import { BalanceService } from "../services/balanceService.js";
import { HDWalletManager } from "./hdWallet.js";
import pino from "pino";

const logger = pino({ name: "withdrawal-processor" });

/**
 * Picks up withdrawal rows queued by the web app and executes them via the
 * HD wallet. Mirrors the security/idempotency contract of the DM withdraw
 * command:
 *
 *   - Atomically transition status queued → pending while debiting the user
 *     in the same SQLite transaction. If the user no longer has the funds,
 *     mark the row 'failed' (no debit happened).
 *   - Call sendFromHotWallet outside the DB transaction (network IO).
 *   - On success: record txid, mark confirmed, notify user via DM.
 *   - On send failure: leave the row at 'pending' with no txid — same
 *     contract as withdrawCommand. Admin checks the chain and resolves.
 */
export class WithdrawalProcessor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private userRepo: UserRepository;
  private transactionRepo: TransactionRepository;
  private balanceService: BalanceService;

  constructor(
    private db: Database.Database,
    private walletManager: HDWalletManager,
    private withdrawalFeeSatoshis: number,
    private pollIntervalMs: number
  ) {
    this.userRepo = new UserRepository(db);
    this.transactionRepo = new TransactionRepository(db);
    this.balanceService = new BalanceService(db);
  }

  start(): void {
    logger.info("Starting withdrawal processor");
    this.tick().catch((err) =>
      logger.error({ err }, "Initial withdrawal tick failed")
    );
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("Withdrawal processor stopped");
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const queued = this.transactionRepo.findQueuedWithdrawals();
      for (const tx of queued) {
        await this.processOne(tx.id);
      }
    } catch (err) {
      logger.error({ err }, "Error in withdrawal tick");
    } finally {
      this.running = false;
    }
  }

  private async processOne(txId: number): Promise<void> {
    const tx = this.transactionRepo.findById(txId);
    if (!tx || tx.status !== "queued") return;
    if (!tx.address) {
      logger.error({ txId }, "Queued withdrawal has no address — marking failed");
      this.transactionRepo.updateStatus(txId, "failed");
      return;
    }

    const totalDebit = tx.amount_satoshis + this.withdrawalFeeSatoshis;

    // Atomically: re-check balance, debit, and flip status queued → pending.
    // If the user's balance changed since the queue insert (concurrent tip,
    // double-queue, whatever), this is the boundary where we catch it.
    type ClaimResult = "claimed" | "insufficient" | "already_taken";
    const claim = this.db.transaction((): ClaimResult => {
      const fresh = this.transactionRepo.findById(txId);
      if (!fresh || fresh.status !== "queued") return "already_taken";
      const user = this.userRepo.findById(tx.user_id);
      if (!user || user.balance_satoshis < totalDebit) return "insufficient";
      const ok = this.balanceService.debit(tx.user_id, totalDebit);
      if (!ok) return "insufficient";
      this.transactionRepo.updateStatus(txId, "pending");
      return "claimed";
    });
    const result = claim.immediate();

    if (result === "already_taken") return;
    if (result === "insufficient") {
      logger.warn(
        { txId, userId: tx.user_id },
        "Queued withdrawal failed — insufficient balance at process time"
      );
      this.transactionRepo.updateStatus(txId, "failed");
      return;
    }

    // Send on-chain. On failure, leave at 'pending' for admin review (no
    // auto-refund — a timed-out send may have already broadcast).
    let txid: string;
    try {
      txid = await this.walletManager.sendFromHotWallet(tx.address, tx.amount_satoshis);
    } catch (err) {
      logger.error(
        {
          err,
          txId,
          userId: tx.user_id,
          address: tx.address,
          amountSatoshis: tx.amount_satoshis,
          totalDebit,
        },
        "WITHDRAWAL UNCERTAIN — manual review required"
      );
      return;
    }

    this.transactionRepo.updateTxid(txId, txid);
    this.transactionRepo.updateStatus(txId, "confirmed");
    logger.info({ txId, userId: tx.user_id, txid }, "Withdrawal sent");
    // User-facing outcome (success/failed/review) is reflected on
    // https://tipbot.cash — we no longer DM because DMs are unreliable
    // under X's E2E rollout.
  }
}
