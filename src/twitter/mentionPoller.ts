import type { TwitterApi } from "twitter-api-v2";
import { PollStateRepository } from "../db/repositories/pollStateRepository.js";
import { TipRepository } from "../db/repositories/tipRepository.js";
import type { CommandContext } from "../types/index.js";
import type Database from "better-sqlite3";
import pino from "pino";

const logger = pino({ name: "mention-poller" });

export class MentionPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollState: PollStateRepository;
  private tipRepo: TipRepository;

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
    this.tipRepo = new TipRepository(db);
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
      const sinceId = this.pollState.get("last_mention_id");

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
      // This catches @bchtip mentions in replies, quote tweets, and standalone posts
      const result = await this.client.v2.search(
        `@${this.botUsername} -from:${this.botUsername}`,
        params
      );

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

        // Skip tweets we've already processed (search API can return duplicates)
        if (sinceId && tweet.id <= sinceId) continue;
        if (this.tipRepo.findByTweetId(tweet.id)) continue;

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
      } else {
        logger.error({ err }, "Error polling mentions");
      }
    }
  }
}
