import type { CommandContext } from "../types/index.js";
import { TipService } from "../services/tipService.js";
import { BalanceService } from "../services/balanceService.js";
import { HDWalletManager } from "../wallet/hdWallet.js";
import { TransactionRepository } from "../db/repositories/transactionRepository.js";
import { Responder } from "../twitter/responder.js";
import {
  isValidCashAddress,
  isValidAmount,
  normalizeCashAddress,
} from "../utils/bchValidation.js";
import { bchToSatoshis, formatBch } from "../utils/satoshiConversion.js";
import type Database from "better-sqlite3";
import pino from "pino";

const logger = pino({ name: "withdraw-command" });

export class WithdrawCommand {
  private balanceService: BalanceService;
  private transactionRepo: TransactionRepository;

  constructor(
    private db: Database.Database,
    private tipService: TipService,
    private walletManager: HDWalletManager,
    private responder: Responder,
    private withdrawalFeeSatoshis: number,
    private minWithdrawalSatoshis: number,
    private maxWithdrawalSatoshis: number
  ) {
    this.balanceService = new BalanceService(db);
    this.transactionRepo = new TransactionRepository(db);
  }

  async execute(
    ctx: CommandContext,
    amountStr: string,
    address: string
  ): Promise<void> {
    // Withdrawals only via DM for privacy
    if (ctx.type !== "dm") {
      await this.responder.replyToTweet(
        ctx.tweetId!,
        "Please DM me your withdrawal request for security."
      );
      return;
    }

    if (!isValidAmount(amountStr)) {
      await this.responder.sendDM(
        ctx.senderTwitterId,
        `Invalid amount: ${amountStr}`
      );
      return;
    }

    if (!isValidCashAddress(address)) {
      await this.responder.sendDM(
        ctx.senderTwitterId,
        `Invalid BCH address: ${address}`
      );
      return;
    }

    const normalizedAddress = normalizeCashAddress(address);
    const amountSatoshis = bchToSatoshis(parseFloat(amountStr));
    const totalDebit = amountSatoshis + this.withdrawalFeeSatoshis;

    if (amountSatoshis < this.minWithdrawalSatoshis) {
      await this.responder.sendDM(
        ctx.senderTwitterId,
        `Minimum withdrawal is ${formatBch(this.minWithdrawalSatoshis)} BCH.`
      );
      return;
    }

    if (amountSatoshis > this.maxWithdrawalSatoshis) {
      await this.responder.sendDM(
        ctx.senderTwitterId,
        `Maximum withdrawal is ${formatBch(this.maxWithdrawalSatoshis)} BCH.`
      );
      return;
    }

    const user = await this.tipService.ensureUser(
      ctx.senderTwitterId,
      ctx.senderUsername
    );

    // Debit balance first
    const debited = this.balanceService.debit(user.id, totalDebit);
    if (!debited) {
      const balance = this.balanceService.getBalance(user.id);
      await this.responder.sendDM(
        ctx.senderTwitterId,
        `Insufficient balance. You have ${formatBch(balance)} BCH. ` +
          `Withdrawal of ${formatBch(amountSatoshis)} BCH + ${formatBch(this.withdrawalFeeSatoshis)} BCH fee = ${formatBch(totalDebit)} BCH needed.`
      );
      return;
    }

    // Record pending transaction
    const txRecord = this.transactionRepo.create(
      user.id,
      "withdrawal",
      amountSatoshis,
      normalizedAddress,
      null
    );

    try {
      // Send on-chain
      const txid = await this.walletManager.sendFromHotWallet(
        normalizedAddress,
        amountSatoshis
      );

      this.transactionRepo.updateTxid(txRecord.id, txid);
      this.transactionRepo.updateStatus(txRecord.id, "confirmed");

      await this.responder.sendDM(
        ctx.senderTwitterId,
        `Withdrawal of ${formatBch(amountSatoshis)} BCH sent!\n` +
          `TX: https://blockchair.com/bitcoin-cash/transaction/${txid}\n` +
          `Fee: ${formatBch(this.withdrawalFeeSatoshis)} BCH`
      );
    } catch (err) {
      // Refund on failure
      logger.error({ err, userId: user.id }, "Withdrawal failed, refunding");
      this.balanceService.credit(user.id, totalDebit);
      this.transactionRepo.updateStatus(txRecord.id, "failed");

      await this.responder.sendDM(
        ctx.senderTwitterId,
        "Withdrawal failed. Your balance has been restored. Please try again later."
      );
    }
  }
}
