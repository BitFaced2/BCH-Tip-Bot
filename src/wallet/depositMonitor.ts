import type Database from "better-sqlite3";
import { UserRepository } from "../db/repositories/userRepository.js";
import { TransactionRepository } from "../db/repositories/transactionRepository.js";
import { BalanceService } from "../services/balanceService.js";
import { HDWalletManager } from "./hdWallet.js";
import { Responder } from "../twitter/responder.js";
import { formatBch } from "../utils/satoshiConversion.js";
import pino from "pino";

const logger = pino({ name: "deposit-monitor" });

export class DepositMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private userRepo: UserRepository;
  private transactionRepo: TransactionRepository;
  private balanceService: BalanceService;

  constructor(
    private db: Database.Database,
    private walletManager: HDWalletManager,
    private responder: Responder,
    private requiredConfirmations: number,
    private pollIntervalMs: number
  ) {
    this.userRepo = new UserRepository(db);
    this.transactionRepo = new TransactionRepository(db);
    this.balanceService = new BalanceService(db);
  }

  start(): void {
    logger.info("Starting deposit monitor");
    this.checkDeposits();
    this.timer = setInterval(
      () => this.checkDeposits(),
      this.pollIntervalMs
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("Deposit monitor stopped");
  }

  private async checkDeposits(): Promise<void> {
    try {
      // Check for new deposits on all user addresses
      await this.scanForNewDeposits();

      // Update confirmation counts on pending deposits
      await this.updatePendingConfirmations();
    } catch (err) {
      logger.error({ err }, "Error checking deposits");
    }
  }

  private async scanForNewDeposits(): Promise<void> {
    const users = this.userRepo.getAll();

    for (const user of users) {
      try {
        const onChainBalance = await this.walletManager.getBalance(
          user.derivation_index
        );

        if (onChainBalance <= BigInt(0)) continue;

        // Get wallet to check history
        const wallet = await this.walletManager.getWalletForIndex(
          user.derivation_index
        );
        const history = await wallet.getHistory();

        if (!history || !Array.isArray(history)) continue;

        for (const tx of history) {
          const txid =
            typeof tx === "object" && tx !== null && "hash" in tx
              ? (tx as { hash: string }).hash
              : null;

          if (!txid) continue;

          // Skip if already tracked
          const existing = this.transactionRepo.findByTxid(txid);
          if (existing) continue;

          // Determine the deposit amount from the transaction
          const valueChange =
            typeof tx === "object" && tx !== null && "valueChange" in tx
              ? Number((tx as { valueChange: number }).valueChange)
              : 0;

          if (valueChange <= 0) continue; // Not an incoming transaction

          const amountSatoshis = Math.abs(valueChange);

          logger.info(
            { txid, userId: user.id, amount: amountSatoshis },
            "New deposit detected"
          );

          this.transactionRepo.create(
            user.id,
            "deposit",
            amountSatoshis,
            user.deposit_address,
            txid
          );
        }
      } catch (err) {
        logger.error(
          { err, userId: user.id },
          "Error scanning deposits for user"
        );
      }
    }
  }

  private async updatePendingConfirmations(): Promise<void> {
    const pending = this.transactionRepo.findPendingDeposits();

    for (const tx of pending) {
      if (!tx.txid) continue;

      try {
        const user = this.userRepo.findById(tx.user_id);
        if (!user) continue;

        const wallet = await this.walletManager.getWalletForIndex(
          user.derivation_index
        );

        // Get transaction history and find our tx by hash
        const history = await wallet.getHistory();
        if (!history || !Array.isArray(history)) continue;

        const matchingTx = history.find(
          (h: any) => h.hash === tx.txid
        ) as any;
        if (!matchingTx) continue;

        // Calculate confirmations from block height
        let confirmations = 0;
        if (matchingTx.blockHeight && matchingTx.blockHeight > 0) {
          // Get current blockchain tip height
          const currentHeight = await wallet.provider!.getBlockHeight();

          if (currentHeight > 0) {
            confirmations = currentHeight - matchingTx.blockHeight + 1;
          } else {
            // Fallback: at least 1 if in a block
            confirmations = 1;
          }
        }

        logger.info(
          { txid: tx.txid, confirmations, blockHeight: matchingTx.blockHeight },
          "Checking deposit confirmations"
        );

        if (confirmations !== tx.confirmations) {
          this.transactionRepo.updateConfirmations(tx.id, confirmations);

          if (confirmations > 0 && tx.status === "pending") {
            this.transactionRepo.updateStatus(tx.id, "confirming");
          }
        }

        if (
          confirmations >= this.requiredConfirmations &&
          tx.status !== "confirmed"
        ) {
          // Credit the user's balance
          this.balanceService.credit(tx.user_id, tx.amount_satoshis);
          this.transactionRepo.updateStatus(tx.id, "confirmed");

          logger.info(
            {
              txid: tx.txid,
              userId: tx.user_id,
              amount: tx.amount_satoshis,
            },
            "Deposit confirmed and credited"
          );

          // Notify the user
          if (!user.twitter_user_id.startsWith("pending_")) {
            await this.responder.sendDM(
              user.twitter_user_id,
              `Deposit of ${formatBch(tx.amount_satoshis)} BCH confirmed! ` +
                `Your balance: ${formatBch(this.balanceService.getBalance(user.id))} BCH`
            );
          }

          // Sweep to hot wallet
          try {
            await this.walletManager.sweepToHotWallet(user.derivation_index);
          } catch (err) {
            logger.error(
              { err, userId: user.id },
              "Failed to sweep deposit to hot wallet"
            );
          }
        }
      } catch (err) {
        logger.error(
          { err, txId: tx.id },
          "Error updating deposit confirmations"
        );
      }
    }
  }
}
