import type { CommandContext } from "../types/index.js";
import { TipService } from "../services/tipService.js";
import { Responder } from "../twitter/responder.js";
import { formatBch } from "../utils/satoshiConversion.js";

export class BalanceCommand {
  constructor(
    private tipService: TipService,
    private responder: Responder
  ) {}

  async execute(ctx: CommandContext): Promise<void> {
    const user = await this.tipService.ensureUser(
      ctx.senderTwitterId,
      ctx.senderUsername
    );

    const message = `Your balance: ${formatBch(user.balance_satoshis)} BCH (${user.balance_satoshis.toLocaleString()} satoshis)`;

    if (ctx.type === "dm") {
      await this.responder.sendDM(ctx.senderTwitterId, message);
    } else {
      await this.responder.replyToTweet(ctx.tweetId!, message);
    }
  }
}
