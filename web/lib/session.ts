import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { config } from "./config.js";

// Stateless signed-cookie sessions. We encode a small JSON payload and sign
// it with HMAC-SHA256 using SESSION_SECRET. The cookie is HttpOnly + Secure
// + SameSite=Lax — no JS access, no cross-site leaks, sent only over HTTPS.
//
// We deliberately avoid express-session + a store: the session payload is
// tiny (just twitterUserId + username + issuedAt) and stateless cookies
// avoid an entire class of server-state bugs.

export interface SessionData {
  twitterUserId: string;
  username: string;
  issuedAt: number;
}

const COOKIE_NAME = "tipbot_session";
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function sign(payload: string): string {
  return createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

function verify(payload: string, signature: string): boolean {
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function setSession(res: Response, data: SessionData): void {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  const sig = sign(payload);
  res.cookie(COOKIE_NAME, `${payload}.${sig}`, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: MAX_AGE_MS,
    path: "/",
  });
}

export function getSession(req: Request): SessionData | null {
  const cookie = req.cookies?.[COOKIE_NAME];
  if (!cookie || typeof cookie !== "string") return null;

  const idx = cookie.lastIndexOf(".");
  if (idx < 0) return null;
  const payload = cookie.slice(0, idx);
  const sig = cookie.slice(idx + 1);
  if (!verify(payload, sig)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionData;
    if (Date.now() - data.issuedAt > MAX_AGE_MS) return null;
    return data;
  } catch {
    return null;
  }
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}
