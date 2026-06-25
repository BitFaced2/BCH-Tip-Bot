import type { CommandContext } from "../types/index.js";
import { Responder } from "../twitter/responder.js";

export class HelpCommand {
  constructor(
    private responder: Responder,
    private botUsername: string
  ) {}

  async execute(ctx: CommandContext): Promise<void> {
    const message = [
      `BCH Tip Bot`,
      ``,
      `Manage your balance, deposit address, and withdrawals at:`,
      `https://tipbot.cash (sign in with X)`,
      ``,
      `Send a tip in a public tweet:`,
      `  @${this.botUsername} tip @user <amount> BCH`,
      ``,
      `Example: @${this.botUsername} tip @alice 0.001 BCH`,
      ``,
      `Receiving tips? Sign in within 7 days to claim. After that, tips return to the sender.`,
    ].join("\n");

    if (ctx.type === "dm") {
      await this.responder.sendDM(ctx.senderTwitterId, message);
    } else {
      await this.responder.replyToTweet(ctx.tweetId!, message);
    }
  }
}
