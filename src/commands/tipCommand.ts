import type { CommandContext } from "../types/index.js";
import { TipService } from "../services/tipService.js";
import { Responder } from "../twitter/responder.js";
import { isValidAmount, isValidUsername } from "../utils/bchValidation.js";
import { formatBch } from "../utils/satoshiConversion.js";

export class TipCommand {
  constructor(
    private tipService: TipService,
    private responder: Responder
  ) {}

  async execute(
    ctx: CommandContext,
    recipientUsername: string,
    amountStr: string
  ): Promise<void> {
    if (!isValidUsername(recipientUsername)) {
      await this.responder.replyToTweet(
        ctx.tweetId!,
        `Invalid username: @${recipientUsername}`
      );
      return;
    }

    if (!isValidAmount(amountStr)) {
      await this.responder.replyToTweet(
        ctx.tweetId!,
        `Invalid amount: ${amountStr}`
      );
      return;
    }

    const amount = parseFloat(amountStr);

    const result = await this.tipService.processTip(
      ctx.senderTwitterId,
      ctx.senderUsername,
      recipientUsername,
      amount,
      ctx.tweetId ?? null
    );

    if (!result.success) {
      // Silently skip already-processed tips
      if (result.error === "This tip has already been processed.") return;

      await this.responder.replyToTweet(ctx.tweetId!, result.error!);
      return;
    }

    const recipientIsNew =
      result.recipient!.twitter_user_id.startsWith("pending_");

    let message = `Tipped @${recipientUsername} ${formatBch(result.recipientReceived!)} BCH!`;

    if (result.feeSatoshis! > 0) {
      message += ` (fee: ${formatBch(result.feeSatoshis!)} BCH)`;
    }

    if (recipientIsNew) {
      message += ` DM me "help" to learn how to use it.`;
    }

    await this.responder.replyToTweet(ctx.tweetId!, message);
  }
}
