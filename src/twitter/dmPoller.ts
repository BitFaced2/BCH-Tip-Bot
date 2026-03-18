import type { TwitterApi } from "twitter-api-v2";
import { PollStateRepository } from "../db/repositories/pollStateRepository.js";
import type { CommandContext } from "../types/index.js";
import pino from "pino";

const logger = pino({ name: "dm-poller" });

export class DMPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollState: PollStateRepository;
  private backoffMs = 0;

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
    logger.info("Starting DM poller");
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("DM poller stopped");
  }

  private async poll(): Promise<void> {
    if (this.backoffMs > 0) {
      this.backoffMs = Math.max(0, this.backoffMs - this.pollIntervalMs);
      return;
    }

    try {
      const paginator = await this.client.v2.listDmEvents({
        "dm_event.fields": ["id", "text", "sender_id", "created_at", "event_type"],
        event_types: "MessageCreate",
        max_results: 100,
      });

      const events = paginator.data?.data;
      if (!events || events.length === 0) return;

      const lastProcessedId = this.pollState.get("last_dm_event_id");

      // Process oldest first, skip already-processed events
      const newEvents = lastProcessedId
        ? events.filter((e) => e.id > lastProcessedId).reverse()
        : [events[events.length - 1]]; // Only process latest on first run

      for (const event of newEvents) {
        if (event.event_type !== "MessageCreate") continue;
        if (event.sender_id === this.botUserId) continue;

        const ctx: CommandContext = {
          type: "dm",
          senderTwitterId: event.sender_id!,
          senderUsername: "", // DMs don't include username — will be resolved by command handler
          text: event.text ?? "",
        };

        try {
          await this.onCommand(ctx);
        } catch (err) {
          logger.error({ err, eventId: event.id }, "Error processing DM");
        }
      }

      // Update to newest event ID
      this.pollState.set("last_dm_event_id", events[0].id);
    } catch (err: any) {
      if (err?.code === 429) {
        this.backoffMs = Math.min(this.backoffMs * 2 || 300_000, 900_000);
        logger.warn(`Rate limited on DM endpoint, backing off ${this.backoffMs / 1000}s`);
      } else {
        logger.error({ err }, "Error polling DMs");
      }
    }
  }
}
