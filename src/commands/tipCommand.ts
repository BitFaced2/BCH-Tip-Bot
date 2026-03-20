import type { CommandContext } from "../types/index.js";
import { TipService } from "../services/tipService.js";
import { Responder } from "../twitter/responder.js";
import { isValidAmount, isValidUsername } from "../utils/bchValidation.js";
import { bchToSatoshis, formatBch } from "../utils/satoshiConversion.js";

export class TipCommand {
  constructor(
    private tipService: TipService,
    private responder: Responder
  ) {}

  private static MAX_RECIPIENTS = 5;

  async execute(
    ctx: CommandContext,
    recipientUsernames: string[],
    amountStr: string
  ): Promise<void> {
    // Deduplicate usernames (case-insensitive)
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const u of recipientUsernames) {
      const lower = u.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        unique.push(u);
      }
    }
    recipientUsernames = unique;

    if (recipientUsernames.length > TipCommand.MAX_RECIPIENTS) {
      await this.responder.replyToTweet(
        ctx.tweetId!,
        `You can tip at most ${TipCommand.MAX_RECIPIENTS} people at once.`
      );
      return;
    }

    for (const username of recipientUsernames) {
      if (!isValidUsername(username)) {
        await this.responder.replyToTweet(
          ctx.tweetId!,
          `Invalid username: @${username}`
        );
        return;
      }
    }

    if (!isValidAmount(amountStr)) {
      await this.responder.replyToTweet(
        ctx.tweetId!,
        `Invalid amount: ${amountStr}`
      );
      return;
    }

    const amount = parseFloat(amountStr);
    const tipped: string[] = [];
    const welcomed: string[] = [];
    const failed: { username: string; reason: string }[] = [];
    let totalFee = 0;

    for (const recipientUsername of recipientUsernames) {
      const result = await this.tipService.processTip(
        ctx.senderTwitterId,
        ctx.senderUsername,
        recipientUsername,
        amount,
        ctx.tweetId ?? null
      );

      if (!result.success) {
        // Silently skip already-processed tips
        if (result.error === "This tip has already been processed.") continue;

        failed.push({ username: `@${recipientUsername}`, reason: result.error! });
        // Stop trying remaining recipients if out of funds
        if (result.error?.includes("Insufficient balance")) break;
        continue;
      }

      tipped.push(`@${recipientUsername}`);
      totalFee += result.feeSatoshis!;

      if (result.recipient!.twitter_user_id.startsWith("pending_")) {
        welcomed.push(recipientUsername);
      }
    }

    if (tipped.length === 0 && failed.length === 0) return;

    if (tipped.length === 0) {
      await this.responder.replyToTweet(
        ctx.tweetId!,
        `Could not send tips. Check your balance by DMing me "balance".`
      );
      return;
    }

    let message = "";

    if (welcomed.length > 0) {
      message += `Welcome to BCH Tip Bot! DM me "help" to get started.\n`;
    }

    const each = tipped.length > 1 ? " each" : "";
    message += `Tipped ${tipped.join(", ")} ${formatBch(bchToSatoshis(amount))} BCH${each}!`;

    if (totalFee > 0) {
      message += ` (fee: ${formatBch(totalFee)} BCH)`;
    }

    if (failed.length > 0) {
      const failNames = failed.map(f => f.username).join(", ");
      message += `\nCould not tip ${failNames}`;
    }

    await this.responder.replyToTweet(ctx.tweetId!, message);
  }
}
