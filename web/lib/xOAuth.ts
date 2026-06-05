import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";

// X OAuth 2.0 with PKCE. Only the bits we need: build the auth-redirect URL,
// exchange the callback `code` for an access token, fetch the signed-in user.

// X has been migrating twitter.com → x.com. The /i/oauth2/authorize page on
// twitter.com redirects mid-flow to x.com and loses session cookies, causing
// an infinite "you must be logged in to X" loop. Point at x.com directly.
// The token and users/me endpoints don't render UI so they stay on
// api.twitter.com for now (still the documented URL).
const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const ME_URL = "https://api.twitter.com/2/users/me";

const SCOPES = ["tweet.read", "users.read"];

export interface PendingAuth {
  state: string;
  codeVerifier: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function createPendingAuth(): PendingAuth {
  return {
    state: base64url(randomBytes(32)),
    codeVerifier: base64url(randomBytes(48)),
  };
}

export function buildAuthorizeUrl(pending: PendingAuth): string {
  const codeChallenge = base64url(createHash("sha256").update(pending.codeVerifier).digest());
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.twitterClientId,
    redirect_uri: config.oauthCallbackUrl,
    scope: SCOPES.join(" "),
    state: pending.state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
  scope: string;
}

export async function exchangeCodeForToken(
  code: string,
  codeVerifier: string
): Promise<string> {
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: config.twitterClientId,
    redirect_uri: config.oauthCallbackUrl,
    code_verifier: codeVerifier,
  });
  const basic = Buffer.from(
    `${config.twitterClientId}:${config.twitterClientSecret}`
  ).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as TokenResponse;
  return data.access_token;
}

interface MeResponse {
  data: { id: string; username: string; name?: string };
}

export async function fetchSignedInUser(
  accessToken: string
): Promise<{ id: string; username: string }> {
  const res = await fetch(ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`users/me failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as MeResponse;
  return { id: data.data.id, username: data.data.username };
}
