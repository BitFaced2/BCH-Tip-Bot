import { config } from "./config.js";

/**
 * Calls the bot's loopback HTTP server. Used when the dashboard needs the
 * bot to perform an operation that requires the HD seed (which we
 * deliberately keep out of the web process). Currently: ensure-user on
 * first sign-in.
 */
export async function ensureUserViaBot(
  twitterUserId: string,
  username: string
): Promise<void> {
  const url = `${config.internalApiUrl.replace(/\/$/, "")}/ensure-user`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.internalApiToken}`,
      },
      body: JSON.stringify({ twitter_user_id: twitterUserId, username }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ensure-user failed (${res.status}): ${text}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
