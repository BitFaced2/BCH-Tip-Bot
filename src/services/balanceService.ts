import type Database from "better-sqlite3";
import { UserRepository } from "../db/repositories/userRepository.js";

export class BalanceService {
  private userRepo: UserRepository;

  constructor(private db: Database.Database) {
    this.userRepo = new UserRepository(db);
  }

  getBalance(userId: number): number {
    const user = this.userRepo.findById(userId);
    return user?.balance_satoshis ?? 0;
  }

  credit(userId: number, amountSatoshis: number): void {
    if (amountSatoshis <= 0) {
      throw new Error("Credit amount must be positive");
    }

    const txn = this.db.transaction(() => {
      const user = this.userRepo.findById(userId);
      if (!user) throw new Error(`User ${userId} not found`);

      this.userRepo.updateBalance(
        userId,
        user.balance_satoshis + amountSatoshis
      );
    });

    txn.immediate();
  }

  debit(userId: number, amountSatoshis: number): boolean {
    if (amountSatoshis <= 0) {
      throw new Error("Debit amount must be positive");
    }

    let success = false;

    const txn = this.db.transaction(() => {
      const user = this.userRepo.findById(userId);
      if (!user) throw new Error(`User ${userId} not found`);

      if (user.balance_satoshis < amountSatoshis) {
        success = false;
        return;
      }

      this.userRepo.updateBalance(
        userId,
        user.balance_satoshis - amountSatoshis
      );
      success = true;
    });

    txn.immediate();
    return success;
  }

  transfer(
    fromUserId: number,
    toUserId: number,
    amountSatoshis: number,
    feeSatoshis: number
  ): boolean {
    if (amountSatoshis <= 0) {
      throw new Error("Transfer amount must be positive");
    }

    let success = false;

    const txn = this.db.transaction(() => {
      const sender = this.userRepo.findById(fromUserId);
      const recipient = this.userRepo.findById(toUserId);

      if (!sender) throw new Error(`Sender ${fromUserId} not found`);
      if (!recipient) throw new Error(`Recipient ${toUserId} not found`);

      if (sender.balance_satoshis < amountSatoshis) {
        success = false;
        return;
      }

      const recipientAmount = amountSatoshis - feeSatoshis;

      this.userRepo.updateBalance(
        fromUserId,
        sender.balance_satoshis - amountSatoshis
      );
      this.userRepo.updateBalance(
        toUserId,
        recipient.balance_satoshis + recipientAmount
      );
      success = true;
    });

    txn.immediate();
    return success;
  }
}
