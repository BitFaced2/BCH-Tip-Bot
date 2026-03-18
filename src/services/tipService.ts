import type Database from "better-sqlite3";
import { UserRepository } from "../db/repositories/userRepository.js";
import { TipRepository } from "../db/repositories/tipRepository.js";
import { BalanceService } from "./balanceService.js";
import { HDWalletManager } from "../wallet/hdWallet.js";
import { bchToSatoshis } from "../utils/satoshiConversion.js";
import type { User } from "../types/index.js";

export interface TipResult {
  success: boolean;
  error?: string;
  sender?: User;
  recipient?: User;
  amountSatoshis?: number;
  feeSatoshis?: number;
  recipientReceived?: number;
}

export class TipService {
  private userRepo: UserRepository;
  private tipRepo: TipRepository;
  private balanceService: BalanceService;
  private feeUserId?: number;

  constructor(
    private db: Database.Database,
    private walletManager: HDWalletManager,
    private tipFeePercent: number,
    private minTipSatoshis: number,
    private feeAddress: string = ""
  ) {
    this.userRepo = new UserRepository(db);
    this.tipRepo = new TipRepository(db);
    this.balanceService = new BalanceService(db);
  }

  async initialize(): Promise<void> {
    if (!this.feeAddress) return;

    // Create or find the fee collection account
    let feeUser = this.userRepo.findByDepositAddress(this.feeAddress);
    if (!feeUser) {
      const index = this.userRepo.getNextDerivationIndex();
      feeUser = this.userRepo.create("system_fee_account", "fee_collector", index, this.feeAddress);
    }
    this.feeUserId = feeUser.id;
  }

  async ensureUser(
    twitterUserId: string,
    twitterUsername: string
  ): Promise<User> {
    let user = this.userRepo.findByTwitterId(twitterUserId);
    if (user) {
      // Update username if changed
      if (user.twitter_username !== twitterUsername && twitterUsername) {
        this.userRepo.updateUsername(user.id, twitterUsername);
        user.twitter_username = twitterUsername;
      }
      return user;
    }

    const index = this.userRepo.getNextDerivationIndex();
    const address = await this.walletManager.deriveAddress(index);
    return this.userRepo.create(twitterUserId, twitterUsername, index, address);
  }

  async ensureUserByUsername(twitterUsername: string): Promise<User> {
    const existing = this.userRepo.findByUsername(twitterUsername);
    if (existing) return existing;

    // Create a placeholder user — we don't have their twitter_user_id yet.
    // Use the username as a temporary ID; it'll be updated when they interact.
    const index = this.userRepo.getNextDerivationIndex();
    const address = await this.walletManager.deriveAddress(index);
    return this.userRepo.create(
      `pending_${twitterUsername.toLowerCase()}`,
      twitterUsername,
      index,
      address
    );
  }

  async processTip(
    senderTwitterId: string,
    senderUsername: string,
    recipientUsername: string,
    amountBch: number,
    tweetId: string | null
  ): Promise<TipResult> {
    // Check idempotency
    if (tweetId) {
      const existing = this.tipRepo.findByTweetId(tweetId);
      if (existing) {
        return { success: false, error: "This tip has already been processed." };
      }
    }

    const amountSatoshis = bchToSatoshis(amountBch);

    if (amountSatoshis < this.minTipSatoshis) {
      return {
        success: false,
        error: `Minimum tip is ${this.minTipSatoshis} satoshis.`,
      };
    }

    const feeSatoshis = Math.floor(amountSatoshis * (this.tipFeePercent / 100));
    const recipientReceived = amountSatoshis - feeSatoshis;

    const sender = await this.ensureUser(senderTwitterId, senderUsername);

    // Don't allow self-tipping
    if (senderUsername.toLowerCase() === recipientUsername.toLowerCase()) {
      return { success: false, error: "You can't tip yourself." };
    }

    const recipient = await this.ensureUserByUsername(recipientUsername);

    // Transfer in a single transaction
    const transferred = this.balanceService.transfer(
      sender.id,
      recipient.id,
      amountSatoshis,
      feeSatoshis,
      this.feeUserId
    );

    if (!transferred) {
      const balance = this.balanceService.getBalance(sender.id);
      return {
        success: false,
        error: `Insufficient balance. You have ${balance} satoshis.`,
        sender,
      };
    }

    // Record the tip
    this.tipRepo.create(
      sender.id,
      recipient.id,
      amountSatoshis,
      feeSatoshis,
      tweetId
    );

    // Refresh user objects
    const updatedSender = this.userRepo.findById(sender.id)!;
    const updatedRecipient = this.userRepo.findById(recipient.id)!;

    return {
      success: true,
      sender: updatedSender,
      recipient: updatedRecipient,
      amountSatoshis,
      feeSatoshis,
      recipientReceived,
    };
  }
}
