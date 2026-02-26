import type { TwitterApi } from "twitter-api-v2";
import pino from "pino";

const logger = pino({ name: "responder" });

export class Responder {
  constructor(private client: TwitterApi) {}

  async replyToTweet(tweetId: string, text: string): Promise<void> {
    try {
      await this.client.v2.reply(text, tweetId);
    } catch (err) {
      logger.error({ err, tweetId }, "Failed to reply to tweet");
    }
  }

  async sendDM(userId: string, text: string): Promise<void> {
    try {
      await this.client.v2.sendDmToParticipant(userId, { text });
    } catch (err) {
      logger.error({ err, userId }, "Failed to send DM");
    }
  }
}
