import type { CommandContext } from "../types/index.js";
import { Responder } from "../twitter/responder.js";

export class HelpCommand {
  constructor(
    private responder: Responder,
    private botUsername: string
  ) {}

  async execute(ctx: CommandContext): Promise<void> {
    const message = [
      `BCH Tip Bot Commands:`,
      ``,
      `Web (recommended): https://tipbot.qube.cash`,
      `  Sign in with X to view balance, deposit address, and withdraw.`,
      ``,
      `DM Commands (may fail for encrypted DMs):`,
      `  deposit - Get your BCH deposit address`,
      `  balance - Check your current balance`,
      `  withdraw <amount> <address> - Withdraw BCH`,
      `  help - Show this message`,
      ``,
      `Public Commands (reply to a tweet):`,
      `  @${this.botUsername} tip @user <amount> BCH`,
      ``,
      `Example: @${this.botUsername} tip @alice 0.001 BCH`,
    ].join("\n");

    if (ctx.type === "dm") {
      await this.responder.sendDM(ctx.senderTwitterId, message);
    } else {
      await this.responder.replyToTweet(ctx.tweetId!, message);
    }
  }
}
