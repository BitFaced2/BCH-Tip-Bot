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

export const config = {
  twitterClientId: required("TWITTER_CLIENT_ID"),
  twitterClientSecret: required("TWITTER_CLIENT_SECRET"),
  oauthCallbackUrl: required("OAUTH_CALLBACK_URL"),
  webBaseUrl: required("WEB_BASE_URL"),
  port: parseInt(process.env.WEB_PORT ?? "3001", 10),
  sessionSecret: required("SESSION_SECRET"),
  dbPath: required("DB_PATH"),
};
