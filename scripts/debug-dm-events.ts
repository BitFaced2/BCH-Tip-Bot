import "dotenv/config";
import { TwitterApi } from "twitter-api-v2";

async function main() {
  const client = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY!,
    appSecret: process.env.TWITTER_API_SECRET!,
    accessToken: process.env.TWITTER_ACCESS_TOKEN!,
    accessSecret: process.env.TWITTER_ACCESS_SECRET!,
  });

  // Single-call view of what the dmPoller actually sees
  const r = await client.v2.listDmEvents({
    "dm_event.fields": [
      "id",
      "text",
      "sender_id",
      "created_at",
      "event_type",
      "dm_conversation_id",
    ],
    event_types: "MessageCreate",
    max_results: 100,
  });

  const events = r.data?.data ?? [];
  console.log(`listDmEvents returned ${events.length} events.`);

  // Group by conversation_id to see if multiple conversations are present
  const byConv = new Map<string, any[]>();
  for (const e of events) {
    const cid = (e as any).dm_conversation_id ?? "unknown";
    if (!byConv.has(cid)) byConv.set(cid, []);
    byConv.get(cid)!.push(e);
  }

  console.log(`\nUnique conversations in this batch: ${byConv.size}`);
  for (const [cid, evs] of byConv.entries()) {
    const latest = evs[0];
    const oldest = evs[evs.length - 1];
    const senders = new Set(evs.map((e) => e.sender_id));
    console.log(
      `  conv=${cid} count=${evs.length} senders=${[...senders].join(",")} ` +
        `newest=${latest.created_at} oldest=${oldest.created_at}`
    );
  }

  console.log(`\nFull batch (newest first), first 15:`);
  for (const e of events.slice(0, 15)) {
    console.log(
      `  ${e.created_at} cid=${(e as any).dm_conversation_id} sender=${e.sender_id} ${JSON.stringify((e.text ?? "").slice(0, 60))}`
    );
  }
}

main().catch((e) => {
  console.error("ERR:", e?.data ?? e?.message ?? e);
  process.exit(1);
});
