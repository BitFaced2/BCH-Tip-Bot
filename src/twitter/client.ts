import { TwitterApi } from "twitter-api-v2";

export function createTwitterClient(
  apiKey: string,
  apiSecret: string,
  accessToken: string,
  accessSecret: string
): TwitterApi {
  return new TwitterApi({
    appKey: apiKey,
    appSecret: apiSecret,
    accessToken,
    accessSecret,
  });
}
