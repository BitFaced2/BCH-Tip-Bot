import type { TwitterApi } from "twitter-api-v2";
import { PollStateRepository } from "../db/repositories/pollStateRepository.js";
import type { CommandContext } from "../types/index.js";
import type Database from "better-sqlite3";
import { withTimeout } from "../utils/withTimeout.js";
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
    this.poll().catch((err) => logger.error({ err }, "Initial mention poll failed"));
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
      // The stored id serves two distinct purposes, and conflating them caused
      // a replay storm on 2026-10-14:
      //
      //   - highWaterMark: the newest mention we have already handled. ALWAYS
      //     used to filter locally.
      //   - sinceId: the same id handed to X to narrow the request. X rejects
      //     ids older than ~7 days, so after a long quiet stretch we must stop
      //     sending it.
      //
      // Previously the local filter was also keyed on sinceId, so the moment
      // the staleness guard dropped it (6 days with no new mentions — routine
      // for a small bot) the poller reprocessed every mention X still returned:
      // 19 old commands replayed at once, and a tweet whose tip had legitimately
      // failed weeks earlier got a fresh "Could not send tips" reply.
      const stored = this.pollState.getWithAge("last_mention_id");
      const STALE_MS = 6 * 24 * 60 * 60 * 1000;
      const isStale = stored
        ? Date.now() - new Date(stored.updatedAt.replace(" ", "T") + "Z").getTime() > STALE_MS
        : false;
      const highWaterMark = stored?.value;
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

      // Poll BOTH the mentions timeline and search, then union — neither
      // endpoint alone is complete:
      //   - search silently drops @-mentions buried past ~char 280 in long
      //     note_tweets (missed tip, 2026-07-06), and was down for 12+ hours
      //     on 2026-07-03;
      //   - the mentions timeline applies X's spam/quality filtering and
      //     silently omits mentions from low-reputation accounts (missed tip
      //     from a legitimate user, 2026-08-16).
      // Duplicates are harmless: tips are idempotent per (tweet_id, recipient),
      // and one healthy endpoint keeps the bot alive when the other degrades.
      // Bot's own tweets are filtered client-side below.
      const [mentionsRes, searchRes] = await Promise.allSettled([
        withTimeout(
          this.client.v2.userMentionTimeline(this.botUserId, params),
          60_000,
          "mention timeline"
        ),
        withTimeout(
          this.client.v2.search(
            `@${this.botUsername} -from:${this.botUsername}`,
            params
          ),
          60_000,
          "mention search"
        ),
      ]);

      if (mentionsRes.status === "rejected" && searchRes.status === "rejected") {
        // Both sources down — let the shared error handling below classify it.
        throw mentionsRes.reason;
      }
      for (const [label, res] of [
        ["mention timeline", mentionsRes],
        ["mention search", searchRes],
      ] as const) {
        if (res.status === "rejected") {
          logger.warn(
            { err: res.reason, source: label },
            "One mention source failed — continuing with the other"
          );
        }
      }

      const tweetById = new Map<string, any>();
      const users = new Map<string, string>();
      if (mentionsRes.status === "fulfilled") {
        for (const tweet of mentionsRes.value.tweets ?? []) {
          tweetById.set(tweet.id, tweet);
        }
        for (const user of mentionsRes.value.includes?.users ?? []) {
          users.set(user.id, user.username);
        }
      }
      if (searchRes.status === "fulfilled") {
        for (const tweet of searchRes.value.data?.data ?? []) {
          if (!tweetById.has(tweet.id)) tweetById.set(tweet.id, tweet);
        }
        for (const user of searchRes.value.data?.includes?.users ?? []) {
          users.set(user.id, user.username);
        }
      }

      // Newest first, matching the per-endpoint ordering the loop below expects.
      const tweets = [...tweetById.values()].sort((a, b) =>
        BigInt(a.id) < BigInt(b.id) ? 1 : -1
      );
      if (tweets.length === 0) return;

      // Process oldest first
      for (const tweet of [...tweets].reverse()) {
        const username = users.get(tweet.author_id!) ?? "unknown";

        // Skip tweets from the bot itself
        if (tweet.author_id === this.botUserId) continue;

        // Skip anything at or below the high-water mark, whether or not we
        // were able to send since_id. BigInt, not string compare: ids of
        // different lengths sort wrong lexicographically.
        if (highWaterMark && BigInt(tweet.id) <= BigInt(highWaterMark)) continue;

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

      // Advance the high-water mark, never retreat it. A stale-since_id
      // request is unfiltered, so its newest result can be older than what
      // we've already processed — writing that back would re-open the
      // window we just closed.
      const newest = tweets[0].id;
      if (!highWaterMark || BigInt(newest) > BigInt(highWaterMark)) {
        this.pollState.set("last_mention_id", newest);
      }
    } catch (err: any) {
      if (err?.code === 429) {
        logger.warn("Rate limited on mentions endpoint, backing off");
        return;
      }

      // X rejects since_id values pointing to tweets older than ~7 days. The
      // local staleness guard normally retires the id first, so this is a
      // backstop for X tightening that window. Backdate the row rather than
      // deleting it: the next poll then omits since_id, but the id survives as
      // the high-water mark that stops already-handled mentions from replaying.
      const sinceIdError = err?.data?.errors?.find(
        (e: any) => e?.parameters?.since_id
      );
      if (err?.code === 400 && sinceIdError) {
        logger.warn("since_id outside 7-day window, retiring it for fresh fetch");
        this.pollState.expire("last_mention_id", 30);
        return;
      }

      logger.error({ err }, "Error polling mentions");
    }
  }
}
