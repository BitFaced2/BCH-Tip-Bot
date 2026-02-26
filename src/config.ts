import "dotenv/config";

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  // X/Twitter API
  twitterApiKey: required("TWITTER_API_KEY"),
  twitterApiSecret: required("TWITTER_API_SECRET"),
  twitterAccessToken: required("TWITTER_ACCESS_TOKEN"),
  twitterAccessSecret: required("TWITTER_ACCESS_SECRET"),
  twitterBearerToken: required("TWITTER_BEARER_TOKEN"),
  twitterBotUserId: required("TWITTER_BOT_USER_ID"),

  // BCH Wallet
  masterSeedMnemonic: required("MASTER_SEED_MNEMONIC"),
  bchNetwork: optional("BCH_NETWORK", "testnet") as "mainnet" | "testnet",

  // Bot Configuration
  pollIntervalMs: parseInt(optional("POLL_INTERVAL_MS", "15000"), 10),
  requiredConfirmations: parseInt(optional("REQUIRED_CONFIRMATIONS", "3"), 10),
  minTipSatoshis: parseInt(optional("MIN_TIP_SATOSHIS", "1000"), 10),
  minWithdrawalSatoshis: parseInt(optional("MIN_WITHDRAWAL_SATOSHIS", "10000"), 10),
  maxWithdrawalSatoshis: parseInt(optional("MAX_WITHDRAWAL_SATOSHIS", "100000000"), 10),
  withdrawalFeeSatoshis: parseInt(optional("WITHDRAWAL_FEE_SATOSHIS", "500"), 10),
  tipFeePercent: parseFloat(optional("TIP_FEE_PERCENT", "1")),

  // Database
  dbPath: optional("DB_PATH", "./data/tipbot.db"),

  // Logging
  logLevel: optional("LOG_LEVEL", "info"),
} as const;
