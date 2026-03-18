// Quick script to look up the numeric user ID for a Twitter/X username.
// Usage: npx tsx scripts/lookup-user-id.ts <username>
// Reads Bearer Token from .env file.

import "dotenv/config";

const bearerToken = process.env.TWITTER_BEARER_TOKEN;
const username = (process.argv[2] ?? "bchtip").replace("@", "");

if (!bearerToken) {
  console.log("Error: TWITTER_BEARER_TOKEN not found in .env");
  process.exit(1);
}

const response = await fetch(
  `https://api.x.com/2/users/by/username/${username}`,
  { headers: { Authorization: `Bearer ${bearerToken}` } }
);

const data = await response.json();

if (data.data) {
  console.log(`\nUsername: @${data.data.username}`);
  console.log(`User ID:  ${data.data.id}`);
  console.log(`Name:     ${data.data.name}`);
  console.log(`\nAdd this to your .env:`);
  console.log(`TWITTER_BOT_USER_ID=${data.data.id}`);
} else {
  console.error("Error:", data);
}
