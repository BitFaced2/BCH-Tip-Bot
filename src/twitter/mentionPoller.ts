import type { TwitterApi } from "twitter-api-v2";
import { PollStateRepository } from "../db/repositories/pollStateRepository.js";
import type { CommandContext } from "../types/index.js";
import pino from "pino";

const logger = pino({ name: "mention-poller" });

export class MentionPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollState: PollStateRepository;

  constructor(
    private client: TwitterApi,
    private botUserId: string,
    private pollIntervalMs: number,
    private onCommand: (ctx: CommandContext) => Promise<void>,
    pollState: PollStateRepository
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
      const sinceId = this.pollState.get("last_mention_id");

      const params: Record<string, string | string[]> = {
        "tweet.fields": ["author_id", "created_at", "text"],
        "user.fields": ["username"],
        expansions: ["author_id"],
      };
      if (sinceId) {
        params.since_id = sinceId;
      }

      const timeline = await this.client.v2.userMentionTimeline(
        this.botUserId,
        params
      );

      const tweets = timeline.data?.data;
      if (!tweets || tweets.length === 0) return;

      const users = new Map<string, string>();
      for (const user of timeline.data?.includes?.users ?? []) {
        users.set(user.id, user.username);
      }

      // Process oldest first
      for (const tweet of [...tweets].reverse()) {
        const username = users.get(tweet.author_id!) ?? "unknown";

        // Skip tweets from the bot itself
        if (tweet.author_id === this.botUserId) continue;

        const ctx: CommandContext = {
          type: "mention",
          senderTwitterId: tweet.author_id!,
          senderUsername: username,
          text: tweet.text,
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
        logger.warn("Rate limited on mentions endpoint, backing off");
      } else {
        logger.error({ err }, "Error polling mentions");
      }
    }
  }
}
