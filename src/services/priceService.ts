import pino from "pino";

const logger = pino({ name: "price-service" });

/**
 * Fetches and caches BCH/USD from CoinGecko's public endpoint. Free, no
 * auth. We cap at one fetch per 60s and fall back to the last known price
 * on transient failures — so a CoinGecko outage degrades to "stale price
 * shown" rather than "tip reply hangs" or "no $ annotation."
 */
export class PriceService {
  private static URL =
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd";
  private static TTL_MS = 60_000;
  private static FETCH_TIMEOUT_MS = 5_000;

  private cachedPrice: number | null = null;
  private lastFetchAt = 0;

  async getBchUsd(): Promise<number | null> {
    const fresh = Date.now() - this.lastFetchAt < PriceService.TTL_MS;
    if (fresh && this.cachedPrice !== null) return this.cachedPrice;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      PriceService.FETCH_TIMEOUT_MS
    );
    try {
      const res = await fetch(PriceService.URL, { signal: controller.signal });
      if (!res.ok) {
        logger.warn({ status: res.status }, "BCH price fetch non-OK");
        return this.cachedPrice;
      }
      const data = (await res.json()) as {
        "bitcoin-cash"?: { usd?: number };
      };
      const price = data["bitcoin-cash"]?.usd;
      if (typeof price === "number" && price > 0) {
        this.cachedPrice = price;
        this.lastFetchAt = Date.now();
        return price;
      }
      logger.warn({ data }, "BCH price response malformed");
      return this.cachedPrice;
    } catch (err) {
      logger.warn({ err }, "BCH price fetch failed");
      return this.cachedPrice;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Format a satoshi amount as a "~$X.XX" annotation. Returns null when the
 * USD value is too small to render meaningfully (less than half a cent),
 * so callers can omit the annotation entirely rather than print "~$0.00".
 */
export function formatUsd(satoshis: number, bchUsd: number | null): string | null {
  if (bchUsd === null || bchUsd <= 0) return null;
  const usd = (satoshis / 1e8) * bchUsd;
  if (usd < 0.005) return null;
  return `~$${usd.toFixed(2)}`;
}
