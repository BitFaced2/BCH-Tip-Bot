import type { CommandContext } from "../types/index.js";
import type { DepositCommand } from "./depositCommand.js";
import type { BalanceCommand } from "./balanceCommand.js";
import type { TipCommand } from "./tipCommand.js";
import type { WithdrawCommand } from "./withdrawCommand.js";
import type { HelpCommand } from "./helpCommand.js";
import pino from "pino";

const logger = pino({ name: "command-router" });

// Matches: tip @user1 @user2 ... 0.001 BCH (one or more recipients)
const TIP_REGEX = /tip\s+((?:@\w{1,15}\s+)+)([\d.]+)\s*BCH/i;

// DM commands
const DM_PATTERNS = {
  deposit: /^deposit$/i,
  balance: /^balance$/i,
  withdraw: /^withdraw\s+([\d.]+)\s+((?:bitcoincash:)?[qp][a-z0-9]+)$/i,
  help: /^help$/i,
} as const;

export interface CommandHandlers {
  deposit: DepositCommand;
  balance: BalanceCommand;
  tip: TipCommand;
  withdraw: WithdrawCommand;
  help: HelpCommand;
}

export class CommandRouter {
  constructor(private handlers: CommandHandlers) {}

  async route(ctx: CommandContext): Promise<void> {
    const text = ctx.text.trim();

    if (ctx.type === "mention") {
      // Only look for tip commands in mentions
      const tipMatch = text.match(TIP_REGEX);
      if (tipMatch) {
        const usernames = tipMatch[1].match(/@(\w{1,15})/g)!.map(u => u.slice(1));
        const amount = tipMatch[2];
        logger.info(
          { sender: ctx.senderUsername, recipients: usernames, amount },
          "Tip command"
        );
        await this.handlers.tip.execute(ctx, usernames, amount);
        return;
      }

      // Ignore DM-style commands in public mentions (deposit, balance, etc.)
      // These should only be used via DM for privacy.
    }

    if (ctx.type === "dm") {
      const match = this.matchDMCommand(text);
      if (match) {
        await this.executeDMCommand(match.command, match.args, ctx);
        return;
      }

      // Unknown command — send help
      await this.handlers.help.execute(ctx);
    }
  }

  private matchDMCommand(
    text: string
  ): { command: keyof typeof DM_PATTERNS; args: RegExpMatchArray } | null {
    for (const [command, pattern] of Object.entries(DM_PATTERNS)) {
      // Strip @botname from the beginning of mention text
      const cleaned = text.replace(/@\w+\s*/g, "").trim();
      const match = cleaned.match(pattern);
      if (match) {
        return { command: command as keyof typeof DM_PATTERNS, args: match };
      }
    }
    return null;
  }

  private async executeDMCommand(
    command: keyof typeof DM_PATTERNS,
    args: RegExpMatchArray,
    ctx: CommandContext
  ): Promise<void> {
    switch (command) {
      case "deposit":
        await this.handlers.deposit.execute(ctx);
        break;
      case "balance":
        await this.handlers.balance.execute(ctx);
        break;
      case "withdraw":
        await this.handlers.withdraw.execute(ctx, args[1], args[2]);
        break;
      case "help":
        await this.handlers.help.execute(ctx);
        break;
    }
  }
}
