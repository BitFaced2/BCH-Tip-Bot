import express from "express";
import cookieParser from "cookie-parser";
import pino from "pino";
import { config } from "./lib/config.js";
import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";

const logger = pino({ name: "tipbot-web" });

const app = express();

// We sit behind nginx; trust the first proxy so req.secure reflects the
// upstream TLS, and req.ip reflects X-Forwarded-For instead of 127.0.0.1.
app.set("trust proxy", 1);

app.use(cookieParser());
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

app.use(authRouter);
app.use(dashboardRouter);

app.use((_req, res) => {
  res.status(404).type("html").send("<h1>404</h1>");
});

app.listen(config.port, "127.0.0.1", () => {
  logger.info({ port: config.port }, "tipbot-web listening");
});
