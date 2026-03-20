import { config } from "./config.js";
import { getDatabase, closeDatabase } from "./db/connection.js";
import { runMigrations } from "./db/schema.js";
import { PollStateRepository } from "./db/repositories/pollStateRepository.js";
import { HDWalletManager } from "./wallet/hdWallet.js";
import { DepositMonitor } from "./wallet/depositMonitor.js";
import { createTwitterClient } from "./twitter/client.js";
import { MentionPoller } from "./twitter/mentionPoller.js";
import { DMPoller } from "./twitter/dmPoller.js";
import { Responder } from "./twitter/responder.js";
import { CommandRouter } from "./commands/commandRouter.js";
import { DepositCommand } from "./commands/depositCommand.js";
import { BalanceCommand } from "./commands/balanceCommand.js";
import { TipCommand } from "./commands/tipCommand.js";
import { WithdrawCommand } from "./commands/withdrawCommand.js";
import { HelpCommand } from "./commands/helpCommand.js";
import { TipService } from "./services/tipService.js";
import pino from "pino";

const logger = pino({ level: config.logLevel, name: "bch-tip-bot" });

async function main(): Promise<void> {
  logger.info("Starting BCH Tip Bot...");

  // 1. Initialize database
  const db = getDatabase(config.dbPath);
  runMigrations(db);
  logger.info("Database initialized");

  // 2. Initialize HD wallet
  const walletManager = new HDWalletManager();
  await walletManager.initialize(config.masterSeedMnemonic, config.bchNetwork);
  logger.info("HD wallet initialized");

  // 3. Initialize Twitter client
  const twitterClient = createTwitterClient(
    config.twitterApiKey,
    config.twitterApiSecret,
    config.twitterAccessToken,
    config.twitterAccessSecret
  );
  const responder = new Responder(twitterClient);
  logger.info("Twitter client initialized");

  // 4. Initialize services
  const tipService = new TipService(
    db,
    walletManager,
    config.tipFeePercent,
    config.minTipSatoshis,
    config.feeAddress
  );
  await tipService.initialize();

  // 5. Initialize command handlers
  const commandRouter = new CommandRouter({
    deposit: new DepositCommand(tipService, responder),
    balance: new BalanceCommand(tipService, responder),
    tip: new TipCommand(tipService, responder),
    withdraw: new WithdrawCommand(
      db,
      tipService,
      walletManager,
      responder,
      config.withdrawalFeeSatoshis,
      config.minWithdrawalSatoshis,
      config.maxWithdrawalSatoshis
    ),
    help: new HelpCommand(responder, "bchtip"),
  });

  // 6. Initialize pollers
  const pollState = new PollStateRepository(db);

  const mentionPoller = new MentionPoller(
    twitterClient,
    config.twitterBotUserId,
    "bchtip",
    config.pollIntervalMs,
    (ctx) => commandRouter.route(ctx),
    pollState,
    db
  );

  const dmPoller = new DMPoller(
    twitterClient,
    config.twitterBotUserId,
    30_000, // Poll DMs every 30 seconds — DMs are infrequent so cost is minimal
    (ctx) => commandRouter.route(ctx),
    pollState
  );

  const depositMonitor = new DepositMonitor(
    db,
    walletManager,
    responder,
    config.requiredConfirmations,
    config.pollIntervalMs * 4 // Check deposits less frequently (every ~60s)
  );

  // 7. Start everything
  mentionPoller.start();
  dmPoller.start();
  depositMonitor.start();

  logger.info("BCH Tip Bot is running!");
  logger.info(
    {
      network: config.bchNetwork,
      pollInterval: config.pollIntervalMs,
      tipFee: `${config.tipFeePercent}%`,
    },
    "Configuration"
  );

  // 8. Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    mentionPoller.stop();
    dmPoller.stop();
    depositMonitor.stop();
    closeDatabase();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start BCH Tip Bot");
  process.exit(1);
});
