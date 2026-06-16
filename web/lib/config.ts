import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Load .env.web on top of the bot's existing .env so we get one merged
// environment. .env.web is preferred for OAuth + session secrets so the bot
// process never has those values in scope.
const webEnvPath = resolve(process.cwd(), ".env.web");
if (existsSync(webEnvPath)) {
  loadEnv({ path: webEnvPath, override: true });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function requiredInt(name: string): number {
  const n = parseInt(required(name), 10);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} is not a valid integer`);
  return n;
}

export const config = {
  twitterClientId: required("TWITTER_CLIENT_ID"),
  twitterClientSecret: required("TWITTER_CLIENT_SECRET"),
  oauthCallbackUrl: required("OAUTH_CALLBACK_URL"),
  webBaseUrl: required("WEB_BASE_URL"),
  port: parseInt(process.env.WEB_PORT ?? "3001", 10),
  sessionSecret: required("SESSION_SECRET"),
  dbPath: required("DB_PATH"),

  // Shared withdrawal config — read from the bot's .env so both processes
  // agree on the limits without duplicating values across .env files.
  minWithdrawalSatoshis: requiredInt("MIN_WITHDRAWAL_SATOSHIS"),
  maxWithdrawalSatoshis: requiredInt("MAX_WITHDRAWAL_SATOSHIS"),
  withdrawalFeeSatoshis: requiredInt("WITHDRAWAL_FEE_SATOSHIS"),

  // Bot's loopback HTTP server, used to ensure-user on first sign-in.
  internalApiUrl: required("INTERNAL_API_URL"),
  internalApiToken: required("INTERNAL_API_TOKEN"),
};
