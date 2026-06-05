import { Router } from "express";
import {
  buildAuthorizeUrl,
  createPendingAuth,
  exchangeCodeForToken,
  fetchSignedInUser,
} from "../lib/xOAuth.js";
import { clearSession, setSession } from "../lib/session.js";
import pino from "pino";

const logger = pino({ name: "auth" });

const PENDING_COOKIE = "tipbot_pending_auth";

export const authRouter = Router();

authRouter.get("/login", (_req, res) => {
  const pending = createPendingAuth();
  // Stash state + verifier in a short-lived cookie so the callback can match
  // them. HttpOnly + Secure + SameSite=Lax so this can't be read or
  // submitted from another origin.
  res.cookie(PENDING_COOKIE, JSON.stringify(pending), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 10 * 60 * 1000, // 10 minutes
    path: "/",
  });
  res.redirect(buildAuthorizeUrl(pending));
});

authRouter.get("/callback", async (req, res) => {
  const pendingRaw = req.cookies?.[PENDING_COOKIE];
  res.clearCookie(PENDING_COOKIE, { path: "/" });

  if (!pendingRaw || typeof pendingRaw !== "string") {
    res.status(400).send("Missing pending auth cookie. Try logging in again.");
    return;
  }

  let pending: { state: string; codeVerifier: string };
  try {
    pending = JSON.parse(pendingRaw);
  } catch {
    res.status(400).send("Malformed pending auth cookie.");
    return;
  }

  const { code, state, error } = req.query as Record<string, string | undefined>;
  if (error) {
    res.status(400).send(`X rejected the authorization: ${error}`);
    return;
  }
  if (!code || !state) {
    res.status(400).send("Missing code or state from X.");
    return;
  }
  if (state !== pending.state) {
    res.status(400).send("State mismatch — possible CSRF. Try logging in again.");
    return;
  }

  try {
    const accessToken = await exchangeCodeForToken(code, pending.codeVerifier);
    const user = await fetchSignedInUser(accessToken);
    setSession(res, {
      twitterUserId: user.id,
      username: user.username,
      issuedAt: Date.now(),
    });
    logger.info({ username: user.username }, "Login successful");
    res.redirect("/");
  } catch (err: any) {
    logger.error({ err }, "OAuth callback failed");
    res.status(500).send("Sign-in failed. Please try again.");
  }
});

authRouter.post("/logout", (_req, res) => {
  clearSession(res);
  res.redirect("/");
});
