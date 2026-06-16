import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { TipService } from "../services/tipService.js";
import pino from "pino";

const logger = pino({ name: "internal-server" });

/**
 * Tiny loopback HTTP server the tipbot-web process calls when it needs the
 * bot to do something only the bot can do — currently just creating a new
 * user account (which requires deriving a deposit address from the HD seed).
 *
 * Binds to 127.0.0.1 exclusively; nginx never proxies this port. Defence
 * in depth: every request must carry Authorization: Bearer <token>, with
 * the token shared via .env so both processes know it without either having
 * to pass it on the network.
 */
export class InternalServer {
  private server: http.Server | null = null;

  constructor(
    private port: number,
    private bearerToken: string,
    private tipService: TipService
  ) {}

  start(): void {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.listen(this.port, "127.0.0.1", () => {
      logger.info({ port: this.port }, "Internal server listening");
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    logger.info("Internal server stopped");
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      res.statusCode = 401;
      res.end();
      return;
    }
    if (req.method !== "POST" || req.url !== "/ensure-user") {
      res.statusCode = 404;
      res.end();
      return;
    }

    let raw = "";
    req.setEncoding("utf8");
    for await (const chunk of req) raw += chunk;
    if (raw.length > 2048) {
      res.statusCode = 413;
      res.end();
      return;
    }

    let body: { twitter_user_id?: string; username?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }

    const id = body.twitter_user_id;
    const username = body.username;
    if (!id || !username || typeof id !== "string" || typeof username !== "string") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "twitter_user_id and username required" }));
      return;
    }
    if (id.startsWith("pending_")) {
      // The web app must never send a pending_* id here; it should call
      // findOrClaimUser locally for those.
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "pending_ ids not accepted" }));
      return;
    }

    try {
      const user = await this.tipService.ensureUser(id, username);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ user }));
    } catch (err: any) {
      logger.error({ err, id, username }, "ensure-user failed");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "ensure-user failed" }));
    }
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const expected = `Bearer ${this.bearerToken}`;
    if (header.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  }
}
