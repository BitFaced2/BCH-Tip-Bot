import type { CommandContext } from "../types/index.js";
import { TipService } from "../services/tipService.js";
import { Responder } from "../twitter/responder.js";

export class DepositCommand {
  constructor(
    private tipService: TipService,
    private responder: Responder
  ) {}

  async execute(ctx: CommandContext): Promise<void> {
    const user = await this.tipService.ensureUser(
      ctx.senderTwitterId,
      ctx.senderUsername
    );

    const message = [
      `Your BCH deposit address:`,
      `${user.deposit_address}`,
      ``,
      `Send BCH to this address. Deposits are credited after 3 confirmations.`,
    ].join("\n");

    if (ctx.type === "dm") {
      await this.responder.sendDM(ctx.senderTwitterId, message);
    } else {
      await this.responder.replyToTweet(ctx.tweetId!, message);
    }
  }
}
