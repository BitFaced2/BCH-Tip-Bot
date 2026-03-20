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

    // Check if there's a pending account for this username that needs to be claimed
    if (twitterUsername) {
      const pendingUser = this.userRepo.findByTwitterId(
        `pending_${twitterUsername.toLowerCase()}`
      );
      if (pendingUser) {
        // Claim the pending account by updating the twitter_user_id
        this.userRepo.updateTwitterId(pendingUser.id, twitterUserId);
        this.userRepo.updateUsername(pendingUser.id, twitterUsername);
        pendingUser.twitter_user_id = twitterUserId;
        pendingUser.twitter_username = twitterUsername;
        return pendingUser;
      }
    }

    const index = this.userRepo.getNextDerivationIndex();
    const address = await this.walletManager.deriveAddress(index);
    return this.userRepo.create(twitterUserId, twitterUsername, index, address);
  }

  async ensureUserByUsername(twitterUsername: string): Promise<User> {
    // Check for existing account by username
    const existing = this.userRepo.findByUsername(twitterUsername);
    if (existing) return existing;

    // Check for a pending account that was already created for this username
    const pending = this.userRepo.findByTwitterId(
      `pending_${twitterUsername.toLowerCase()}`
    );
    if (pending) return pending;

    // Check all users in case the account exists but username wasn't set
    // (e.g., created via DM where username is empty)
    const allUsers = this.userRepo.getAll();
    for (const user of allUsers) {
      if (
        user.twitter_username &&
        user.twitter_username.toLowerCase() === twitterUsername.toLowerCase()
      ) {
        return user;
      }
    }

    // Create a placeholder user — we don't have their twitter_user_id yet.
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
    const amountSatoshis = bchToSatoshis(amountBch);

    if (amountSatoshis < this.minTipSatoshis) {
      return {
        success: false,
        error: `Minimum tip is ${this.minTipSatoshis} satoshis.`,
      };
    }

    // Only charge fee if a fee account is configured, otherwise fee is zero
    const feeSatoshis = this.feeUserId
      ? Math.floor(amountSatoshis * (this.tipFeePercent / 100))
      : 0;
    const totalCost = amountSatoshis + feeSatoshis;

    const sender = await this.ensureUser(senderTwitterId, senderUsername);

    // Don't allow self-tipping
    if (senderUsername.toLowerCase() === recipientUsername.toLowerCase()) {
      return { success: false, error: "You can't tip yourself." };
    }

    const recipient = await this.ensureUserByUsername(recipientUsername);

    // Check idempotency per recipient (supports multi-tip tweets)
    if (tweetId) {
      const existing = this.tipRepo.findByTweetIdAndRecipient(tweetId, recipient.id);
      if (existing) {
        return { success: false, error: "This tip has already been processed." };
      }
    }

    // Transfer — sender pays amount + fee, recipient gets full amount
    const transferred = this.balanceService.transfer(
      sender.id,
      recipient.id,
      totalCost,
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
      recipientReceived: amountSatoshis,
    };
  }
}
