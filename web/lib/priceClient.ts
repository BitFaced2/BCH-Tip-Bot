import pino from "pino";

const logger = pino({ name: "price-client" });

const URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd";
const TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

let cachedPrice: number | null = null;
let lastFetchAt = 0;

/**
 * Get cached or freshly-fetched BCH/USD. Same TTL/timeout/stale-fallback
 * pattern as the bot's PriceService — duplicated rather than shared to
 * keep web/ free of imports from src/.
 */
export async function getBchUsd(): Promise<number | null> {
  if (Date.now() - lastFetchAt < TTL_MS && cachedPrice !== null) {
    return cachedPrice;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(URL, { signal: controller.signal });
    if (!res.ok) {
      logger.warn({ status: res.status }, "BCH price fetch non-OK");
      return cachedPrice;
    }
    const data = (await res.json()) as { "bitcoin-cash"?: { usd?: number } };
    const price = data["bitcoin-cash"]?.usd;
    if (typeof price === "number" && price > 0) {
      cachedPrice = price;
      lastFetchAt = Date.now();
      return price;
    }
    logger.warn({ data }, "BCH price response malformed");
    return cachedPrice;
  } catch (err) {
    logger.warn({ err }, "BCH price fetch failed");
    return cachedPrice;
  } finally {
    clearTimeout(timer);
  }
}

export function formatUsd(satoshis: number, bchUsd: number | null): string | null {
  if (bchUsd === null || bchUsd <= 0) return null;
  const usd = (satoshis / 1e8) * bchUsd;
  if (usd < 0.005) return null;
  return `~$${usd.toFixed(2)}`;
}
