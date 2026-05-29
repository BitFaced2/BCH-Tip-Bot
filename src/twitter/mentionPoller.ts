import type { TwitterApi } from "twitter-api-v2";
import { PollStateRepository } from "../db/repositories/pollStateRepository.js";
import type { CommandContext } from "../types/index.js";
import type Database from "better-sqlite3";
import pino from "pino";

const logger = pino({ name: "mention-poller" });

export class MentionPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollState: PollStateRepository;

  constructor(
    private client: TwitterApi,
    private botUserId: string,
    private botUsername: string,
    private pollIntervalMs: number,
    private onCommand: (ctx: CommandContext) => Promise<void>,
    pollState: PollStateRepository,
    db: Database.Database
  ) {
    this.pollState = pollState;
  }

  start(): void {
    logger.info("Starting mention poller");
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("Mention poller stopped");
  }

  private async poll(): Promise<void> {
    try {
      // X's search API rejects since_id values from tweets older than ~7 days.
      // If our stored since_id is approaching that window, skip it so the next
      // successful response refreshes the value naturally.
      const stored = this.pollState.getWithAge("last_mention_id");
      const STALE_MS = 6 * 24 * 60 * 60 * 1000;
      const isStale = stored
        ? Date.now() - new Date(stored.updatedAt.replace(" ", "T") + "Z").getTime() > STALE_MS
        : false;
      const sinceId = stored && !isStale ? stored.value : undefined;

      const params: Record<string, any> = {
        "tweet.fields": ["author_id", "created_at", "text", "note_tweet"],
        "user.fields": ["username"],
        expansions: ["author_id"],
        max_results: 100,
      };
      if (sinceId) {
        params.since_id = sinceId;
      }

      // Use search endpoint instead of mentions timeline
      // This catches @bchtip mentions in replies, quote tweets, and standalone posts.
      // twitter-api-v2 has no built-in request timeout, so race against one to
      // prevent a hung socket from silently stalling the poller indefinitely.
      const SEARCH_TIMEOUT_MS = 60_000;
      const result = await Promise.race([
        this.client.v2.search(
          `@${this.botUsername} -from:${this.botUsername}`,
          params
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Mention search timed out after ${SEARCH_TIMEOUT_MS}ms`)),
            SEARCH_TIMEOUT_MS
          )
        ),
      ]);

      const tweets = result.data?.data;
      if (!tweets || tweets.length === 0) return;

      const users = new Map<string, string>();
      for (const user of result.data?.includes?.users ?? []) {
        users.set(user.id, user.username);
      }

      // Process oldest first
      for (const tweet of [...tweets].reverse()) {
        const username = users.get(tweet.author_id!) ?? "unknown";

        // Skip tweets from the bot itself
        if (tweet.author_id === this.botUserId) continue;

        // Skip tweets older than our last processed ID
        if (sinceId && tweet.id <= sinceId) continue;

        const ctx: CommandContext = {
          type: "mention",
          senderTwitterId: tweet.author_id!,
          senderUsername: username,
          text: tweet.note_tweet?.text ?? tweet.text,
          tweetId: tweet.id,
        };

        try {
          await this.onCommand(ctx);
        } catch (err) {
          logger.error({ err, tweetId: tweet.id }, "Error processing mention");
        }
      }

      // Update since_id to the newest tweet
      this.pollState.set("last_mention_id", tweets[0].id);
    } catch (err: any) {
      if (err?.code === 429) {
        logger.warn("Rate limited on search endpoint, backing off");
        return;
      }

      // X rejects since_id values pointing to tweets older than ~7 days.
      // Clear the row so the next poll fetches the latest tweets without a
      // since_id; tipService dedups by (tweet_id, recipient) so re-processing
      // already-handled mentions is a no-op.
      const sinceIdError = err?.data?.errors?.find(
        (e: any) => e?.parameters?.since_id
      );
      if (err?.code === 400 && sinceIdError) {
        logger.warn("since_id outside 7-day window, clearing for fresh fetch");
        this.pollState.delete("last_mention_id");
        return;
      }

      logger.error({ err }, "Error polling mentions");
    }
  }
}
